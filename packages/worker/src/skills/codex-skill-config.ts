import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { CodexAppServer } from "../harness/agent-runtime/codex-client.js";
import { resolveCodexCommand } from "../harness/native/native-cli.js";
import { writeFileAtomic } from "../platform/storage.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";

interface NativeSkill {
  scope: string;
  path: string;
  enabled: boolean;
}

/** Codex reports canonical SKILL.md paths, including skills from plugins
 * and ancestor repositories. Use its inventory so discovery stays native. */
export async function configureCodexSkills(
  managed: ManagedSkillRuntime,
  cwd: string,
  env: NodeJS.ProcessEnv,
  configHome: string,
  signal?: AbortSignal,
  {
    open = () => new CodexAppServer(resolveCodexCommand(), env, cwd),
    timeoutMs = 3000,
  }: {
    open?: () => Pick<CodexAppServer, "request" | "close">;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let client: Pick<CodexAppServer, "request" | "close"> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client?.close());
  const abort = () => void close()?.catch(() => {});
  let skills: NativeSkill[];
  try {
    client = open();
    stop.addEventListener("abort", abort, { once: true });
    stop.throwIfAborted();
    const listed = await client.request("skills/list", {
      cwds: [cwd],
      forceReload: true,
    });
    stop.throwIfAborted();
    const inventory = listed?.data?.[0]?.skills;
    if (!Array.isArray(inventory)) throw new Error("Invalid skills/list reply");
    skills = inventory;
  } catch {
    signal?.throwIfAborted();
    const reason = deadline.aborted ? "timed out" : "failed";
    console.warn(
      `Codex skills/list ${reason}; non-Foundry skills could not be disabled for this session.`,
    );
    return;
  } finally {
    stop.removeEventListener("abort", abort);
    await close();
  }
  writeCodexSkillRules(managed, skills, configHome);
}

export function writeCodexSkillRules(
  managed: ManagedSkillRuntime,
  skills: NativeSkill[],
  configHome: string,
): void {
  const allowed = new Set(
    managed.skills.map((skill) => realpathSync(join(skill.dir, "SKILL.md"))),
  );
  const overrides = new Map<string, boolean>();
  for (const skill of skills) {
    const enabled = skill.scope === "system" || allowed.has(skill.path);
    if (enabled !== skill.enabled) overrides.set(skill.path, enabled);
  }
  if (!overrides.size) return;
  const path = join(configHome, "config.toml");
  const config = parse(readFileSync(path, "utf8"));
  const settings = (config.skills ?? {}) as {
    config?: { path?: string; enabled: boolean }[];
  };
  config.skills = {
    ...settings,
    config: [
      ...(settings.config ?? []).filter(
        (rule) => !rule.path || !overrides.has(rule.path),
      ),
      ...Array.from(overrides, ([path, enabled]) => ({ path, enabled })),
    ],
  };
  writeFileAtomic(path, stringify(config), {
    hardenParent: false,
    fsync: false,
  });
}
