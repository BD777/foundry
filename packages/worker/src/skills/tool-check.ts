import type {
  CheckToolPayload,
  SkillBundleCheckStep,
  ToolCheckedPayload,
} from "@bd777/foundry-protocol";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { redactSecrets } from "../platform/secret-redaction.js";
import { errorMessage } from "../platform/utils.js";
import { toolVersionEntry, withManagedTools } from "./managed-tools.js";

/**
 * check_tool (docs/skills.md, Bundle 版本): checks one installed or staged
 * tool version on this device. It always runs the version folder's own
 * program, never the moving bin link: `--version` must name the version,
 * then each command the connector's catalog declares runs in the
 * environment a session with the check's accounts gets. The first failure
 * ends the check; later steps are reported as not run.
 */

export interface ToolCheckEnvironment {
  environment: NodeJS.ProcessEnv;
  release(): void;
}

export interface ToolCheckOptions {
  /**
   * The session environment for the check's accounts (connectors/index.ts
   * prepareConnectorCheck); undefined when none could be set up.
   */
  prepareEnvironment?: (
    payload: CheckToolPayload,
  ) => Promise<ToolCheckEnvironment | undefined>;
  versionTimeoutMs?: number;
  commandTimeoutMs?: number;
}

const detailLimit = 500;
const argument = /^[^\0]{0,200}$/;

interface RunResult {
  code: number;
  output: string;
  /** Standard output alone, for the value a passed command shows. */
  stdout: string;
  timedOut: boolean;
}

function runEntry(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    execFile(
      entry,
      args,
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failed = error as
          | (Error & { code?: unknown; killed?: boolean; signal?: unknown })
          | null;
        resolveRun({
          code: failed
            ? typeof failed.code === "number"
              ? failed.code
              : 1
            : 0,
          output:
            `${String(stdout ?? "")}\n${String(stderr ?? "")}`.trim() ||
            (failed && typeof failed.code !== "number" ? failed.message : ""),
          stdout: String(stdout ?? ""),
          timedOut: Boolean(failed?.killed && failed.signal),
        });
      },
    );
  });
}

/** The end of the output, secrets removed, at most detailLimit chars. */
function detail(prefix: string, output: string): string {
  const redacted = redactSecrets(output.trim());
  const room = detailLimit - prefix.length;
  const end =
    redacted.length > room ? `…${redacted.slice(-(room - 1))}` : redacted;
  return `${prefix}${end}`.trim();
}

function outcome(
  name: string,
  result: RunResult,
  timeoutMs: number,
  expect: string | undefined,
): SkillBundleCheckStep {
  if (result.timedOut)
    return {
      name,
      state: "failed",
      detail: detail(`timed out after ${timeoutMs / 1000} s: `, result.output),
    };
  if (result.code !== 0)
    return {
      name,
      state: "failed",
      detail: detail(`exit ${result.code}: `, result.output),
    };
  if (expect && !result.output.includes(expect))
    return {
      name,
      state: "failed",
      detail: detail(`output lacks "${expect.slice(0, 80)}": `, result.output),
    };
  // A passed step reports no output: it can name the account.
  return { name, state: "passed" };
}

const printedVersion = /v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*/;

/**
 * The value at a dotted path of a command's JSON output (an account's
 * display name), as one short line; "" when there is none.
 */
export function shownValue(stdout: string, path: string | undefined): string {
  if (!path) return "";
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return "";
  }
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return "";
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
}

export async function checkTool(
  payload: CheckToolPayload,
  options: ToolCheckOptions = {},
): Promise<ToolCheckedPayload> {
  const name = payload?.tool?.name ?? "";
  const version = payload?.tool?.version ?? "";
  let entry: string;
  try {
    entry = toolVersionEntry(name, version);
  } catch (error) {
    return { name, version, steps: [], error: errorMessage(error) };
  }
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  for (const command of commands)
    if (
      !Array.isArray(command?.args) ||
      !command.args.every(
        (arg) => typeof arg === "string" && argument.test(arg),
      )
    )
      return { name, version, steps: [], error: "invalid check command" };
  const commandStep = (args: string[]) => `${name} ${args.join(" ")}`.trim();
  const steps: SkillBundleCheckStep[] = [];
  const notRun = (from: number, why: string) => {
    for (const command of commands.slice(from))
      steps.push({
        name: commandStep(command.args),
        state: "skipped",
        detail: why,
      });
  };
  const versionStep = `${name} --version`;
  if (!existsSync(entry)) {
    steps.push({
      name: versionStep,
      state: "failed",
      detail: `${name} ${version} is not installed on this device`,
    });
    notRun(0, "not run: an earlier step failed");
    return { name, version, steps };
  }
  // The checked version's folder comes first, so a command that runs the
  // tool by name runs this version too.
  const path = `${dirname(entry)}:${withManagedTools(process.env.PATH)}`;
  const versionTimeout = options.versionTimeoutMs ?? 5_000;
  const wanted = version.replace(/^v/, "");
  const printed = await runEntry(
    entry,
    ["--version"],
    { ...process.env, PATH: path, NO_COLOR: "1" },
    versionTimeout,
  );
  const reported: SkillBundleCheckStep = {
    ...outcome(versionStep, printed, versionTimeout, wanted),
    kind: "version" as const,
  };
  if (reported.state === "passed")
    reported.value = printed.output.match(printedVersion)?.[0] ?? version;
  steps.push(reported);
  if (reported.state !== "passed") {
    notRun(0, "not run: an earlier step failed");
    return { name, version, steps };
  }
  if (commands.length === 0) return { name, version, steps };
  if (!payload.externalAccounts?.length) {
    notRun(0, "no account to check with");
    return { name, version, steps };
  }
  // Accounts were given but their session environment cannot be built:
  // the version is not shown to work, so the check fails.
  const unprepared = (why: string) => {
    steps.push({
      name: commandStep(commands[0]!.args),
      state: "failed",
      detail: detail("", why),
    });
    notRun(1, "not run: an earlier step failed");
    return { name, version, steps };
  };
  let prepared: ToolCheckEnvironment | undefined;
  try {
    prepared = await options.prepareEnvironment?.(payload);
  } catch (error) {
    return unprepared(
      `the account's session environment failed: ${errorMessage(error)}`,
    );
  }
  if (!prepared)
    return unprepared("the account's session environment could not be set up");
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homedir(),
      ...prepared.environment,
      PATH: path,
      NO_COLOR: "1",
    };
    const commandTimeout = options.commandTimeoutMs ?? 30_000;
    for (const [index, command] of commands.entries()) {
      const result = await runEntry(entry, command.args, env, commandTimeout);
      const step: SkillBundleCheckStep = {
        ...outcome(
          commandStep(command.args),
          result,
          commandTimeout,
          command.expect,
        ),
        ...(command.result ? { kind: command.result } : {}),
      };
      if (step.state === "passed") {
        const value = shownValue(result.stdout, command.show);
        if (value) step.value = value;
      }
      steps.push(step);
      if (step.state !== "passed") {
        notRun(index + 1, "not run: an earlier step failed");
        break;
      }
    }
  } finally {
    prepared.release();
  }
  return { name, version, steps };
}
