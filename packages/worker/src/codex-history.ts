import { realpath, mkdir, symlink, lstat, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { findSessionLog } from "./native-usage.js";
import { nativeSourcePaths } from "./native-runtime-paths.js";
import type { CodexAppServer } from "./agent-runtime/codex-client.js";
/** Read a complete JSONL header, including native base instructions of any size. */
export async function nativeHistoryHeader(path: string) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return JSON.parse(line);
    throw new Error("Empty native history header");
  } catch (error) {
    throw new Error(`Cannot parse native history header: ${path}`, {
      cause: error,
    });
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A collected execution home can leave Codex's index pointing at a dead
 * symlink. Recover only the same transcript in the selected native data source;
 * never start a replacement thread or rewrite the native database. */
export async function codexHistoryRequest(
  client: Pick<CodexAppServer, "request">,
  params: Record<string, unknown> & { threadId: string },
  env: NodeJS.ProcessEnv,
  method = "thread/resume",
) {
  try {
    return await client.request(method, params);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!error.message.includes(
        `no rollout found for thread id ${params.threadId}`,
      ) &&
        !error.message.includes("no archived rollout found"))
    )
      throw error;
    const home = nativeSourcePaths("codex", env).dataHome;
    const archivedName = (
      await readdir(resolve(home, "archived_sessions")).catch(
        () => [] as string[],
      )
    ).find((name) => name.endsWith(`-${params.threadId}.jsonl`));
    const found =
      (await findSessionLog("codex", params.threadId, [home])) ??
      (archivedName
        ? resolve(home, "archived_sessions", archivedName)
        : undefined);
    if (!found) throw error;
    const path = await realpath(found);
    const folder = path.includes(`${sep}archived_sessions${sep}`)
      ? "archived_sessions"
      : "sessions";
    const inside = relative(await realpath(resolve(home, folder)), path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw error;
    const header = await nativeHistoryHeader(path);
    if (
      header.type !== "session_meta" ||
      header.payload?.id !== params.threadId
    )
      throw error;
    // Paginated native threads reject changing their indexed rollout path.
    // Restore only the missing, generated history alias named by native metadata.
    // Configuration and credentials are never recreated in that retired home.
    if (env.FOUNDRY_RUNTIME_CONFIG_ISOLATED !== "1" || !env.CODEX_HOME)
      throw error;
    const metadata = await client.request("thread/read", {
      threadId: params.threadId,
      includeTurns: false,
    });
    if (
      metadata.thread?.id !== params.threadId ||
      typeof metadata.thread.path !== "string"
    )
      throw error;
    const parent = dirname(resolve(env.CODEX_HOME));
    const indexed = resolve(metadata.thread.path);
    const pieces = relative(parent, indexed).split(sep);
    if (
      pieces.length < 3 ||
      !/^[a-f0-9]{24}$/.test(pieces[0] ?? "") ||
      pieces[1] !== folder ||
      resolve(home, ...pieces.slice(1)) !== path
    )
      throw error;
    if ((await lstat(parent)).isSymbolicLink()) throw error;
    const retired = resolve(parent, pieces[0]!);
    try {
      await lstat(retired);
      throw error;
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
    await mkdir(retired, { mode: 0o700 });
    await symlink(resolve(home, folder), resolve(retired, folder), "dir");
    const result = await client.request(method, params);
    if (method === "thread/resume" && result.thread?.id !== params.threadId)
      throw new Error("Codex resumed a different thread; no input was sent.");
    return result;
  }
}
