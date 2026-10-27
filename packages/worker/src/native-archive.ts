import { externalConnectionDataHome } from "./session-ambient.js";
/** Reversible native history operations. Never edit a provider's database. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  lstat,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve, relative, isAbsolute } from "node:path";
import type {
  NativeArchiveItem,
  NativeArchiveResult,
} from "@bd777/foundry-protocol";
import {
  nativeSourcePaths,
  withNativeSourceOverrides,
} from "./native-runtime-paths.js";
import {
  configuredAgentProfiles,
  profileID,
  profileRuntimeEnvironment,
} from "./profiles.js";
import { isolatedCodexEnvironment } from "./runtime-isolation.js";
import { CodexAppServer } from "./agent-runtime/codex-client.js";
import { resolveCodexCommand } from "./native-cli.js";
import { nativeHistoryHeader, codexHistoryRequest } from "./codex-history.js";
import {
  codexHomeCandidates,
  claudeHomeCandidates,
  invalidateNativeChatListings,
} from "./native-chat.js";
import { activeClaudeRuntimes } from "./session-state.js";

const exec = promisify(execFile);
const uuid = /^[\w-]{8,}$/;
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** No symlink traversal below a selected native history root. */
export async function nativeArchiveLogs(
  home: string,
  provider: "codex" | "claude",
  id: string,
): Promise<string[]> {
  if (!uuid.test(id)) throw new Error("Invalid native session id");
  const folder = provider === "codex" ? "sessions" : "projects";
  const result: string[] = [];
  const roots = [
    resolve(home, folder),
    resolve(home, "archived_sessions", provider === "claude" ? "projects" : ""),
  ];
  for (const root of roots) {
    const pending = [{ path: root, depth: 0 }];
    while (pending.length) {
      const { path, depth } = pending.pop()!;
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory() && depth < (provider === "codex" ? 3 : 1))
          pending.push({ path: child, depth: depth + 1 });
        if (
          entry.isFile() &&
          (provider === "claude"
            ? entry.name === `${id}.jsonl`
            : entry.name.endsWith(`-${id}.jsonl`))
        )
          result.push(child);
      }
    }
  }
  return result;
}

async function ownsWorkspace(
  path: string,
  provider: "codex" | "claude",
  id: string,
  workspace: string,
): Promise<boolean> {
  if (provider === "codex") {
    const row = await nativeHistoryHeader(path);
    return (
      row.type === "session_meta" &&
      row.payload?.id === id &&
      typeof row.payload.cwd === "string" &&
      resolve(row.payload.cwd) === resolve(workspace)
    );
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (row.sessionId === id && typeof row.cwd === "string")
        return resolve(row.cwd) === resolve(workspace);
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function staleArchiveLock(path: string): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Unsafe native archive lock: ${path}`);
  let owner;
  try {
    owner = JSON.parse(await readFile(resolve(path, "owner.json"), "utf8"));
  } catch {}
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    return false;
  }
  const age = Date.now() - info.mtimeMs;
  return Number.isFinite(age) && age >= 10 * 60_000;
}

/** Live owners are never evicted by age. Old legacy/incomplete locks can be reclaimed. */
export async function acquireNativeArchiveLock(
  lock: string,
  waitMs = 0,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const ownerPath = resolve(lock, "owner.json");
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (owner.token === token)
          await rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Serialize stale reclamation, then re-read ownership under that gate.
    const gate = `${lock}.reap`;
    let reaping = false;
    try {
      await mkdir(gate, { mode: 0o700 });
      reaping = true;
      await writeFile(
        resolve(gate, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        { flag: "wx", mode: 0o600 },
      );
      const stale = await staleArchiveLock(lock);
      if (stale) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await staleArchiveLock(gate).catch(() => false))
      ) {
        await rm(gate, { recursive: true, force: true });
        continue;
      }
      if (
        !["ENOENT", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    } finally {
      if (reaping) await rm(gate, { recursive: true, force: true });
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Native archive in use: another archive operation owns the lock ${lock}`,
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
    );
  }
}

async function claudeInUse(id: string, path: string): Promise<boolean> {
  if (
    [...activeClaudeRuntimes.values()].some(
      (run) => !run.closed && run.nativeSessionId === id,
    )
  )
    return true;
  if (Date.now() - (await stat(path)).mtimeMs < 120_000) return true;
  // Native CLIs close transcripts between writes; --resume still identifies an owner.
  const { stdout: processes } = await exec("ps", ["-eo", "pid=,args="], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (
    processes
      .split("\n")
      .some(
        (line) =>
          /(?:claude|cli\.js)/i.test(line) &&
          line.includes(id) &&
          /(?:--resume|--session-id)/.test(line),
      )
  )
    return true;
  // A separate Claude CLI may own a file even when this worker has no runtime.
  try {
    const { stdout } = await exec("lsof", ["-t", "--", path], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return Boolean(stdout.trim());
  } catch (error) {
    if (
      (error as { code?: unknown }).code === 1 &&
      !(error as { stdout?: string }).stdout?.trim()
    )
      return false;
    throw new Error("Cannot verify whether Claude history is in use", {
      cause: error,
    });
  }
}

/** Manifest paths are validated against the known project slug, never trusted as destinations. */
export async function archiveClaudeSession(
  home: string,
  id: string,
  desired: "archived" | "active",
  options: {
    sessionId?: string;
    workspacePath?: string;
    inUse?: (id: string, path: string) => Promise<boolean>;
    lockWaitMs?: number;
    resume?: boolean;
    fork?: boolean;
  } = {},
): Promise<"archived" | "active" | "not_found"> {
  if (!uuid.test(id)) throw new Error("Invalid native session id");
  const lock = resolve(home, "archived_sessions", ".locks", id);
  const release = await acquireNativeArchiveLock(lock, options.lockWaitMs);
  try {
    const logs = await nativeArchiveLogs(home, "claude", id);
    if (!logs.length) return "not_found";
    if (logs.length !== 1)
      throw new Error("Claude archive conflict: duplicate transcripts");
    const path = logs[0]!;
    if (
      !(options.resume && path.startsWith(resolve(home, "projects") + "/")) &&
      options.workspacePath &&
      !(await ownsWorkspace(path, "claude", id, options.workspacePath))
    )
      throw new Error("Native session workspace does not match");
    const slug = basename(dirname(path));
    const active = resolve(home, "projects", slug, `${id}.jsonl`);
    const archived = resolve(
      home,
      "archived_sessions",
      "projects",
      slug,
      `${id}.jsonl`,
    );
    const manifest = archived.replace(/\.jsonl$/, ".foundry-archive.json");
    const source = desired === "archived" ? active : archived;
    const target = desired === "archived" ? archived : active;
    if (options.fork && path !== active)
      throw new Error(
        "Cannot fork an archived native session; unarchive the source first.",
      );
    if (path === target) {
      if (desired === "archived") {
        const saved = JSON.parse(await readFile(manifest, "utf8"));
        if (
          saved.version !== 1 ||
          saved.nativeSessionId !== id ||
          saved.originalPath !== active
        )
          throw new Error("Invalid Claude archive manifest");
        if (await present(active.slice(0, -6)))
          throw new Error("Claude archive conflict: companion remains active");
      }
      return desired;
    }
    if (await (options.inUse ?? claudeInUse)(id, source))
      throw new Error(
        "Claude archive in use: stop it and wait two minutes after its last write",
      );
    const sourceDir = source.slice(0, -6);
    const targetDir = target.slice(0, -6);
    if ((await present(target)) || (await present(targetDir)))
      throw new Error("Claude archive conflict: destination exists");
    // Resolve the selected root and reject project slug symlinks before moving.
    for (const root of [
      resolve(home, "projects"),
      resolve(home, "archived_sessions", "projects"),
    ]) {
      if ((await present(root)) && (await lstat(root)).isSymbolicLink())
        throw new Error("Claude archive conflict: history root is a symlink");
      if (
        (await present(resolve(root, slug))) &&
        (await lstat(resolve(root, slug))).isSymbolicLink()
      )
        throw new Error("Claude archive conflict: project slug is a symlink");
    }
    if ((await present(sourceDir)) && !(await lstat(sourceDir)).isDirectory())
      throw new Error("Claude archive conflict: companion is not a directory");
    if (desired === "active") {
      const saved = JSON.parse(await readFile(manifest, "utf8"));
      if (
        saved.version !== 1 ||
        saved.nativeSessionId !== id ||
        saved.originalPath !== active
      )
        throw new Error("Invalid Claude archive manifest");
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (desired === "archived")
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          nativeSessionId: id,
          originalPath: active,
          archivedAt: new Date().toISOString(),
          sessionId: options.sessionId,
        }),
        { flag: "wx", mode: 0o600 },
      );
    let movedCompanion = false;
    try {
      if (await present(sourceDir)) {
        await rename(sourceDir, targetDir);
        movedCompanion = true;
      }
      await rename(source, target);
    } catch (error) {
      if (movedCompanion) await rename(targetDir, sourceDir);
      if (desired === "archived") await rm(manifest);
      throw error;
    }
    if (desired === "active") await rm(manifest);
    invalidateNativeChatListings();
    return desired;
  } finally {
    await release();
  }
}

export async function restoreClaudeSessionForResume(
  id: string,
  env: NodeJS.ProcessEnv,
  workspacePath: string,
  fork = false,
): Promise<void> {
  const home = nativeSourcePaths("claude", env).dataHome;
  const lock = resolve(home, "archived_sessions", ".locks", id);
  const archivedRoot = resolve(home, "archived_sessions") + "/";
  if (
    !(await present(lock)) &&
    !(await nativeArchiveLogs(home, "claude", id)).some((path) =>
      path.startsWith(archivedRoot),
    )
  )
    return;
  await archiveClaudeSession(home, id, "active", {
    workspacePath,
    lockWaitMs: 30_000,
    resume: true,
    fork,
    inUse: async () => false,
  });
}

interface CodexArchiveManifest {
  version: 1;
  nativeSessionId: string;
  activeDescendantIds: string[];
}

/** Native thread/list can omit unindexed/hidden subagents. Archive itself walks
 * rollout metadata, so discover from those same active rollouts before it moves them. */
export async function codexDescendants(
  home: string,
  id: string,
): Promise<string[]> {
  const parents = new Map<string, string>();
  const activeIds = new Set<string>();
  const pending = [
    { path: resolve(home, "sessions"), depth: 0, archived: false },
    { path: resolve(home, "archived_sessions"), depth: 0, archived: true },
  ];
  while (pending.length) {
    const { path, depth, archived } = pending.pop()!;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory() && depth < 3 && !archived)
        pending.push({ path: child, depth: depth + 1, archived });
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const row = await nativeHistoryHeader(child);
      if (
        row?.type !== "session_meta" ||
        typeof row.payload?.id !== "string" ||
        !uuid.test(row.payload.id)
      )
        throw new Error(`Invalid Codex session metadata: ${child}`);
      const meta = row.payload;
      if (!archived && typeof meta?.id === "string") activeIds.add(meta.id);
      const spawn =
        meta?.source?.subagent?.thread_spawn ??
        meta?.source?.subAgent?.thread_spawn;
      const parent =
        meta?.parent_thread_id ??
        meta?.parentThreadId ??
        spawn?.parent_thread_id;
      if (
        parent !== undefined &&
        (typeof parent !== "string" || !uuid.test(parent))
      )
        throw new Error(`Invalid Codex parent metadata: ${child}`);
      if (typeof meta?.id === "string" && typeof parent === "string")
        parents.set(meta.id, parent);
    }
  }
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of parents)
      if (
        child !== id &&
        (parent === id || descendants.has(parent)) &&
        !descendants.has(child)
      ) {
        if (!uuid.test(child))
          throw new Error("Codex returned an invalid descendant id");
        descendants.add(child);
        changed = true;
      }
  }
  return [...descendants].filter((child) => activeIds.has(child)).sort();
}

async function codexArchived(
  home: string,
  id: string,
): Promise<boolean | undefined> {
  const logs = await nativeArchiveLogs(home, "codex", id);
  if (!logs.length) return undefined;
  if (logs.length !== 1)
    throw new Error("Codex archive conflict: duplicate rollouts");
  const root = resolve(home, "archived_sessions");
  const rel = relative(
    await realpath(root).catch(() => root),
    await realpath(logs[0]!),
  );
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export async function archiveCodexThread(
  client: Pick<CodexAppServer, "request">,
  id: string,
  desired: "archived" | "active",
  env: NodeJS.ProcessEnv,
  onDescendants?: (ids: string[]) => void,
  lockWaitMs = 0,
): Promise<"archived" | "active" | "not_found"> {
  if (!uuid.test(id)) throw new Error("Invalid native session id");
  const home = nativeSourcePaths("codex", env).dataHome;
  const manifests = resolve(home, "archived_sessions", ".foundry-archive");
  const manifestPath = resolve(manifests, `${id}.json`);
  const lock = resolve(manifests, `${id}.lock`);
  const release = await acquireNativeArchiveLock(lock, lockWaitMs);
  try {
    if ((await codexArchived(home, id)) === undefined) return "not_found";
    let manifest: CodexArchiveManifest | undefined;
    if (await present(manifestPath)) {
      const saved = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        saved.version !== 1 ||
        saved.nativeSessionId !== id ||
        !Array.isArray(saved.activeDescendantIds) ||
        !saved.activeDescendantIds.every(
          (child: unknown) =>
            typeof child === "string" && uuid.test(child) && child !== id,
        )
      )
        throw new Error("Invalid Codex archive manifest");
      manifest = saved;
    }
    const archived = await codexArchived(home, id);
    if (desired === "archived" && !archived) {
      // Codex archive cascades. Persist precisely the active descendants before the first mutation.
      // Merge on retry after failure; never forget descendants already moved by a partial native call.
      const descendants = await codexDescendants(home, id);
      manifest = {
        version: 1,
        nativeSessionId: id,
        activeDescendantIds: [
          ...new Set([
            ...(manifest?.activeDescendantIds ?? []),
            ...descendants,
          ]),
        ].sort(),
      };
      const temporary = `${manifestPath}.tmp`;
      await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
      await rename(temporary, manifestPath);
    }
    onDescendants?.(manifest?.activeDescendantIds ?? []);
    if (archived !== (desired === "archived")) {
      await codexHistoryRequest(
        client,
        { threadId: id },
        env,
        desired === "archived" ? "thread/archive" : "thread/unarchive",
      );
      if ((await codexArchived(home, id)) !== (desired === "archived"))
        throw new Error("Codex archive did not confirm the desired state");
    }
    if (desired === "active" && manifest) {
      for (const child of manifest.activeDescendantIds) {
        const childArchived = await codexArchived(home, child);
        if (childArchived === undefined)
          throw new Error(
            `Codex descendant ${child} was not found; archive manifest retained for retry`,
          );
        if (childArchived) {
          await codexHistoryRequest(
            client,
            { threadId: child },
            env,
            "thread/unarchive",
          );
          if ((await codexArchived(home, child)) !== false)
            throw new Error(
              `Codex descendant ${child} restore was not confirmed`,
            );
        }
      }
      await rm(manifestPath);
    }
    invalidateNativeChatListings();
    return desired;
  } finally {
    await release();
  }
}

// Serializing all operations also preserves generation ordering across homes and profiles.
let archiveQueue: Promise<unknown> = Promise.resolve();
const generations = new Map<
  string,
  { generation: number; desired: string; result: NativeArchiveResult }
>();
export function applyNativeArchive(
  item: NativeArchiveItem,
  inUse = false,
  dryRun = false,
): Promise<NativeArchiveResult> {
  const operation = archiveQueue.then(
    async (): Promise<NativeArchiveResult> => {
      const key = `${item.provider}:${item.nativeSessionId}`;
      const previous = generations.get(key);
      if (!dryRun && previous && previous.generation > item.generation)
        return {
          ...item,
          state: "pending",
          error: "Superseded archive generation",
        };
      let result: NativeArchiveResult;
      try {
        if (
          !uuid.test(item.nativeSessionId) ||
          !Number.isSafeInteger(item.generation) ||
          item.generation < 0 ||
          !["active", "archived"].includes(item.desired) ||
          !["claude", "codex"].includes(item.provider)
        )
          throw new Error("Invalid native archive request");
        if (inUse) throw new Error("Native session is in use");
        const profiles = configuredAgentProfiles(item.workspacePath).filter(
          (profile) => profile.runtime === item.provider,
        );
        const selected = item.profileId
          ? profiles.find((profile) => profileID(profile) === item.profileId)
          : undefined;
        const ordered = selected
          ? [selected, ...profiles.filter((profile) => profile !== selected)]
          : profiles;
        const homes = new Set<string>();
        const candidates: Array<{
          home: string;
          env: NodeJS.ProcessEnv;
          profile?: typeof selected;
        }> = [];
        for (const profile of ordered) {
          const env = withNativeSourceOverrides(
            process.env,
            profileRuntimeEnvironment(profile),
          );
          const home =
            profile.connectionType === "external" && item.provider === "claude"
              ? externalConnectionDataHome(profile)
              : nativeSourcePaths(item.provider, env).dataHome;
          if (!homes.has(home)) {
            homes.add(home);
            candidates.push({ home, env, profile });
          }
        }
        for (const home of item.provider === "codex"
          ? codexHomeCandidates()
          : claudeHomeCandidates())
          if (!homes.has(home))
            candidates.push({
              home,
              env: withNativeSourceOverrides(
                process.env,
                item.provider === "codex"
                  ? { CODEX_HOME: home }
                  : { CLAUDE_CONFIG_DIR: home },
              ),
            });
        result = { ...item, state: "not_found" };
        for (const candidate of candidates) {
          const paths = await nativeArchiveLogs(
            candidate.home,
            item.provider,
            item.nativeSessionId,
          );
          if (!paths.length) continue;
          if (
            paths.length !== 1 ||
            !(await ownsWorkspace(
              paths[0]!,
              item.provider,
              item.nativeSessionId,
              item.workspacePath,
            ))
          )
            throw new Error("Native archive conflict or workspace mismatch");
          if (item.provider === "claude" && dryRun)
            result.state = paths[0]!.startsWith(
              resolve(candidate.home, "archived_sessions") + "/",
            )
              ? "archived"
              : "active";
          else if (item.provider === "claude")
            result.state = await archiveClaudeSession(
              candidate.home,
              item.nativeSessionId,
              item.desired,
              item,
            );
          else if (dryRun) {
            result.state = (await codexArchived(
              candidate.home,
              item.nativeSessionId,
            ))
              ? "archived"
              : "active";
            Object.assign(result, {
              nativeDescendantIds: await codexDescendants(
                candidate.home,
                item.nativeSessionId,
              ),
            });
          } else {
            const env =
              candidate.profile && !dryRun
                ? isolatedCodexEnvironment(
                    candidate.profile,
                    candidate.env,
                    item.workspacePath,
                    item.sessionId || `archive:${item.nativeSessionId}`,
                  )
                : candidate.env;
            const client = new CodexAppServer(
              candidate.profile?.command || resolveCodexCommand(),
              env,
              item.workspacePath,
            );
            try {
              result.state = await archiveCodexThread(
                client,
                item.nativeSessionId,
                item.desired,
                env,
                (ids) => Object.assign(result, { nativeDescendantIds: ids }),
              );
            } finally {
              await client.close();
            }
          }
          break;
        }
      } catch (error) {
        result = {
          ...item,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!dryRun)
        generations.set(key, {
          generation: item.generation,
          desired: item.desired,
          result,
        });
      return result;
    },
  );
  archiveQueue = operation.catch(() => {});
  return operation;
}
