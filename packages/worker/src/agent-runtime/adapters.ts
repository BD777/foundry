/** Stable native runtimes, prepared beside the old version before activation. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { foundryToolsRoot } from "../state-root.js";
import {
  resolveCodexCommand,
  resolveClaudeCommand,
  clearNativeCliCache,
  parseCliVersion,
} from "../native-cli.js";
import {
  activateRuntime,
  runtimeDescriptor,
  type AgentRuntimeId,
} from "./state.js";
import { stablePackageVersion } from "./release-source.js";
import { CodexAppServer } from "./codex-client.js";
import type { AgentUpdateAdapter, UpdatePlan } from "./update-controller.js";
const exec = promisify(execFile);
const sdkPackage = "@anthropic-ai/claude-agent-sdk";
async function version(executable: string): Promise<string> {
  const result = await exec(executable, ["--version"], { timeout: 15000 });
  const value = parseCliVersion(result.stdout);
  if (!value) throw new Error("The agent executable did not report a version.");
  return value;
}
function resolvedPath(command: string): string {
  if (command.includes("/")) return realpathSync(command);
  for (const entry of (process.env.PATH ?? "").split(":")) {
    const candidate = join(entry, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("Agent executable disappeared.");
}
async function installPackage(
  prefix: string,
  name: string,
  target: string,
  optional: boolean,
): Promise<void> {
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--registry=https://registry.npmjs.org",
      "--@openai:registry=https://registry.npmjs.org",
      "--@anthropic-ai:registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      ...(optional ? ["--include=optional"] : ["--omit=optional"]),
      `${name}@${target}`,
    ],
    { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
}
function runtimePackage(id: AgentRuntimeId): string {
  return id === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
}

/**
 * Install the official stable release as a Foundry-managed copy: the same
 * staging, validation and activation as an update, so later updates are
 * automatic. Used when the runtime is missing, or when the person replaces a
 * copy Foundry cannot update with a managed one. Returns the version.
 */
export async function installManagedRuntime(
  id: AgentRuntimeId,
): Promise<string> {
  const target = await stablePackageVersion(
    runtimePackage(id),
    id === "claude" ? "stable" : "latest",
  );
  const sdkTarget =
    id === "claude" ? await stablePackageVersion(sdkPackage) : undefined;
  await nativeUpdateAdapter(id).update({
    current: "",
    target,
    sdkTarget,
    needed: true,
    managed: true,
  });
  return target;
}

/**
 * Runs a new Codex build the way Foundry's sessions use it before it is
 * activated. The session runtime owns that check (runner/codex-compatibility),
 * so the composition root registers it here rather than this module importing
 * the session runtime.
 */
type CodexBuildCheck = (executable: string, scratch: string) => Promise<void>;
let codexBuildCheck: CodexBuildCheck | undefined;
export function checkCodexBuildsWith(check: CodexBuildCheck): void {
  codexBuildCheck = check;
}

export function nativeUpdateAdapter(id: AgentRuntimeId): AgentUpdateAdapter {
  const packageName = runtimePackage(id);
  return {
    id,
    async inspect() {
      let command: string;
      try {
        command =
          id === "codex" ? resolveCodexCommand() : resolveClaudeCommand();
      } catch {
        return undefined;
      }
      const current = await version(command);
      const target = await stablePackageVersion(
        packageName,
        id === "claude" ? "stable" : "latest",
      );
      const sdkTarget =
        id === "claude" ? await stablePackageVersion(sdkPackage) : undefined;
      const path = resolvedPath(command);
      const pinned =
        process.env[
          id === "codex" ? "FOUNDRY_CODEX_BIN" : "FOUNDRY_CLAUDE_BIN"
        ] || (id === "codex" ? process.env.CODEX_CLI_PATH : undefined);
      const external = pinned
        ? "Executable is explicitly pinned; update that installation or remove the pin."
        : path.includes(".app/Contents/")
          ? "This runtime is owned by its desktop app. Update the app to obtain a stable runtime."
          : /\/(?:Caskroom|Cellar)\//.test(path) || path.startsWith("/usr/bin/")
            ? "This runtime is managed by the system package manager. Update it through that installation."
            : undefined;
      return {
        current,
        target,
        sdkTarget,
        external,
        needed:
          current !== target ||
          (id === "claude" && runtimeDescriptor(id)?.sdkVersion !== sdkTarget),
      };
    },
    async update(plan: UpdatePlan) {
      const root = resolve(
        foundryToolsRoot(),
        "agent-runtimes",
        id,
        `${plan.target}${plan.sdkTarget ? `-sdk-${plan.sdkTarget}` : ""}`,
      );
      const cliRoot = resolve(root, "cli");
      // A missing runtime, or one the person asked to replace with a
      // Foundry-managed copy, is never reused in place.
      let installed: string | undefined;
      try {
        installed =
          id === "codex" ? resolveCodexCommand() : resolveClaudeCommand();
      } catch {
        installed = undefined;
      }
      const reused =
        !plan.managed &&
        installed !== undefined &&
        (await version(installed)) === plan.target
          ? installed
          : undefined;
      const reuse = reused !== undefined;
      const executable = reused
        ? resolvedPath(reused)
        : resolve(cliRoot, "node_modules", ".bin", id);
      let candidateVersion: string | undefined;
      if (existsSync(executable)) {
        try {
          candidateVersion = await version(executable);
        } catch {
          /* An interrupted native package install may leave its placeholder. */
        }
      }
      if (!reuse && candidateVersion !== plan.target) {
        await installPackage(cliRoot, packageName, plan.target, true);
        // Claude's official package links its platform binary over a placeholder.
        // Run only this known installer, not arbitrary dependency lifecycle scripts.
        const installer = resolve(
          cliRoot,
          "node_modules",
          "@anthropic-ai/claude-code",
          "install.cjs",
        );
        if (id === "claude" && existsSync(installer))
          await exec(process.execPath, [installer], {
            cwd: cliRoot,
            timeout: 60000,
          });
      }
      if ((await version(executable)) !== plan.target)
        throw new Error(
          "Installed runtime version does not match the stable target.",
        );
      let sdkEntry: string | undefined;
      if (plan.sdkTarget) {
        const sdkRoot = resolve(root, "sdk");
        const manifest = resolve(
          sdkRoot,
          "node_modules",
          sdkPackage,
          "package.json",
        );
        if (
          !existsSync(manifest) ||
          JSON.parse(readFileSync(manifest, "utf8")).version !== plan.sdkTarget
        )
          await installPackage(sdkRoot, sdkPackage, plan.sdkTarget, false);
        sdkEntry = createRequire(resolve(sdkRoot, "package.json")).resolve(
          sdkPackage,
        );
        await exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const m=await import(process.argv[1]);if(typeof m.query!=='function')process.exit(1)",
            sdkEntry,
          ],
          { timeout: 15000 },
        );
      }
      const scratch = mkdtempSync(join(tmpdir(), "foundry-agent-validation-"));
      try {
        if (id === "codex") {
          const client = new CodexAppServer(
            executable,
            { PATH: process.env.PATH, HOME: scratch, CODEX_HOME: scratch },
            scratch,
            { initializeMs: 20000, controlMs: 20000 },
          );
          try {
            await client.request("model/list", {
              limit: 100,
              includeHidden: false,
            });
          } finally {
            await client.close();
          }
          if (!codexBuildCheck)
            throw new Error(
              "No Codex compatibility check is registered; refusing to activate an unchecked Codex.",
            );
          await codexBuildCheck(executable, scratch);
        } else if (sdkEntry) {
          const script = `
const sdk = await import(process.argv[1]);
let done;
const closed = new Promise(r => done = r);
async function* input() { await closed; }
const q = sdk.query({prompt:input(),options:{
  pathToClaudeCodeExecutable:process.argv[2],cwd:process.argv[3],
  env:{HOME:process.argv[3],CLAUDE_CONFIG_DIR:process.argv[3],DISABLE_AUTOUPDATER:'1',
    ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_API_KEY:''},
  tools:[],mcpServers:{},settingSources:[],persistSession:false,
}});
try { if (!Array.isArray(await q.supportedModels())) throw Error('Invalid native model metadata'); }
finally { q.close(); done(); }
`;
          await exec(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              script,
              pathToFileURL(sdkEntry).href,
              executable,
              scratch,
            ],
            { timeout: 25000 },
          );
        }
        // Only the immutable descriptor switches; credentials and user config never move.
        activateRuntime(id, {
          executable,
          version: plan.target,
          sdkEntry,
          sdkVersion: plan.sdkTarget,
          generation: randomUUID(),
        });
        clearNativeCliCache();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
