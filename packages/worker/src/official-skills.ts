/**
 * The skills Claude Code and Codex ship themselves. Workspace skill isolation
 * keeps them: a session sees its own agent's official skills plus the skills
 * its workspace selected, never the device's other installed skills.
 *
 * Each agent is asked through its own interface, without a model request:
 * Codex's app-server lists them with scope "system"; Claude Code's are the
 * session commands that disappear when its bundled skills are disabled. The
 * result is kept per program version, since it changes only with the program.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficialSkill } from "@bd777/foundry-protocol";
import { withCodexControl } from "./native-inspection.js";
import { nativeCli } from "./native-cli.js";
import { foundryStatePath } from "./state-root.js";
import { writeJSON } from "./storage.js";
import { resolveClaudeCommand } from "./utils.js";

type Runtime = "claude" | "codex";

export interface InstalledOfficialSkill extends OfficialSkill {
  /** Codex: its SKILL.md, offered to the session by path. */
  path?: string;
}

type OfficialSkillCache = Partial<
  Record<Runtime, { version: string; skills: InstalledOfficialSkill[] }>
>;

const cachePath = () => foundryStatePath("official-skills.json");

function readCache(): OfficialSkillCache {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as OfficialSkillCache;
  } catch {
    return {};
  }
}

function programVersion(runtime: Runtime): string | undefined {
  const cli = nativeCli(runtime);
  return cli.installed ? (cli.version ?? "unknown") : undefined;
}

/** The runtime's official skills, if read for its installed version. */
export function officialSkills(
  runtime: Runtime,
): InstalledOfficialSkill[] | undefined {
  const version = programVersion(runtime);
  const cached = readCache()[runtime];
  return version && cached?.version === version ? cached.skills : undefined;
}

async function readCodexOfficialSkills(): Promise<InstalledOfficialSkill[]> {
  const cwd = mkdtempSync(join(tmpdir(), "foundry-official-skills-"));
  try {
    return await withCodexControl(
      "",
      async (call) => {
        const result = await call("skills/list", {
          cwds: [cwd],
          forceReload: true,
        });
        const skills: Array<{
          name?: string;
          description?: string;
          path?: string;
          scope?: string;
        }> = result?.data?.[0]?.skills ?? [];
        return skills
          .filter((skill) => skill.scope === "system" && skill.name)
          .map((skill) => ({
            name: skill.name!,
            description: skill.description,
            path: skill.path,
          }));
      },
      { cwd, env: process.env, args: [] },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function claudeSessionCommands(
  cwd: string,
  bundled: boolean,
): Promise<Array<{ name: string; description?: string }>> {
  const packageName = "@anthropic-ai/claude-agent-sdk";
  const sdk = (await import(packageName)) as {
    query: (input: {
      prompt: AsyncIterable<never>;
      options: Record<string, unknown>;
    }) => {
      initializationResult: () => Promise<{
        commands: Array<{ name: string; description?: string }>;
      }>;
    };
  };
  const abortController = new AbortController();
  // Nothing is ever sent: the session starts, reports what it offers, ends.
  const silent = (async function* (): AsyncGenerator<never> {
    await new Promise(() => {});
  })();
  const session = sdk.query({
    prompt: silent,
    options: {
      abortController,
      cwd,
      env: {
        ...process.env,
        ...(bundled ? {} : { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" }),
      },
      pathToClaudeCodeExecutable: resolveClaudeCommand(),
      settingSources: [],
    },
  });
  try {
    return (await session.initializationResult()).commands;
  } finally {
    abortController.abort();
  }
}

async function readClaudeOfficialSkills(): Promise<InstalledOfficialSkill[]> {
  const cwd = mkdtempSync(join(tmpdir(), "foundry-official-skills-"));
  try {
    const [withBundled, without] = await Promise.all([
      claudeSessionCommands(cwd, true),
      claudeSessionCommands(cwd, false),
    ]);
    const plain = new Set(without.map((command) => command.name));
    return withBundled
      .filter((command) => !plain.has(command.name))
      .map((command) => ({
        name: command.name,
        description: command.description,
      }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Reads the official skills of each installed agent whose version has none
 * recorded yet. Resolves true when anything new was recorded.
 */
export async function refreshOfficialSkills(
  runtimes: Runtime[] = ["claude", "codex"],
): Promise<boolean> {
  const cache = readCache();
  let changed = false;
  for (const runtime of runtimes) {
    const version = programVersion(runtime);
    if (!version || cache[runtime]?.version === version) continue;
    try {
      const skills =
        runtime === "codex"
          ? await readCodexOfficialSkills()
          : await readClaudeOfficialSkills();
      cache[runtime] = { version, skills };
      changed = true;
    } catch (error) {
      console.error(
        `Reading ${runtime}'s official skills failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (changed) writeJSON(cachePath(), cache);
  return changed;
}
