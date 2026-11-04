import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NativeSignInRequestPayload,
  NativeSignInStep,
} from "@bd777/foundry-protocol";
import { resolveClaudeCommand, resolveCodexCommand } from "./native-cli.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { clearNativeLoginHealth } from "./native-login.js";
import { foundryStatePath } from "../../platform/state-root.js";

/**
 * The official subscriptions' own sign-in, run on the device for its owner
 * (native_sign_in): Claude Code's claude.ai login (a page, then the code it
 * shows pasted back) and Codex's ChatGPT device code. The CLI signs in to the
 * configuration the worker's sessions use, and its token exchange leaves
 * from the device; the person opens the page in their own browser and the
 * server only relays the page and codes. Signing out is the CLI's logout.
 */

type Runtime = "claude" | "codex";

const waitForPageMs = 30_000;
const signInLifetimeMs = 15 * 60_000;

// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The page `claude auth login` asks the person to open; they paste a code back. */
export function parseClaudeLoginPage(output: string): string | undefined {
  return /(https:\/\/[^\s]+\/oauth\/authorize\?[^\s]+)/.exec(
    output.replace(ansi, ""),
  )?.[1];
}

/** The page and one-time code of `codex login --device-auth`. */
export function parseCodexDeviceCode(
  output: string,
): { url: string; code: string } | undefined {
  const text = output.replace(ansi, "");
  const url = /(https:\/\/auth\.openai\.com\/[^\s]*device[^\s]*)/.exec(
    text,
  )?.[1];
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(
    text,
  )?.[1];
  return url && code ? { url, code } : undefined;
}

const runtimeName: Record<Runtime, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The CLI's last words, never a URL with its state or a code in them. */
function failure(output: string, runtime: Runtime): string {
  const line =
    output
      .replace(ansi, "")
      .replace(/paste code here if prompted\s*>\s*/gi, "\n")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(
        (entry) =>
          entry && !/https?:\/\/|one-time code|opening browser/i.test(entry),
      )
      .at(-1) ?? "";
  return (line || `${runtimeName[runtime]} could not sign in.`).slice(0, 300);
}

function command(runtime: Runtime): string {
  return runtime === "claude" ? resolveClaudeCommand() : resolveCodexCommand();
}

function environment(runtime: Runtime): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...nativeLoginEnvironment(runtime),
    // The sign-in page opens in the person's own browser, not the device's.
    BROWSER: "true",
    NO_COLOR: "1",
  };
}

/**
 * A sign-in runs in its own process group and outlives a worker restart;
 * Claude Code's waits for a code forever. Its pid is kept so the next
 * worker, or the next attempt, ends it.
 */
const signInPidsPath = foundryStatePath("native-sign-ins.json");
const signInArgs: Record<Runtime, string[]> = {
  claude: ["auth", "login", "--claudeai"],
  codex: ["login", "--device-auth"],
};
const signOutArgs: Record<Runtime, string[]> = {
  claude: ["auth", "logout"],
  codex: ["logout"],
};

function signInPids(): Partial<Record<Runtime, number>> {
  try {
    const parsed = JSON.parse(readFileSync(signInPidsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function recordSignInPid(runtime: Runtime, pid: number | undefined): void {
  const pids = signInPids();
  if (pid) pids[runtime] = pid;
  else delete pids[runtime];
  try {
    mkdirSync(dirname(signInPidsPath), { recursive: true });
    writeFileSync(signInPidsPath, JSON.stringify(pids), { mode: 0o600 });
  } catch {
    // Without the record a left sign-in ends only with its own timeout.
  }
}

/** Ends a sign-in an earlier worker left, if that pid is still one. */
function endLeftSignIn(runtime: Runtime): void {
  const pid = signInPids()[runtime];
  if (!Number.isInteger(pid) || !pid || pid <= 1) return;
  const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim();
  if (args?.endsWith(signInArgs[runtime].join(" "))) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  recordSignInPid(runtime, undefined);
}

/** Ends the sign-ins a previous worker process left running. */
export function reapNativeSignIns(): void {
  endLeftSignIn("claude");
  endLeftSignIn("codex");
}

type Step = Omit<NativeSignInStep, "operationId">;

/** The one sign-in of a runtime running on this device, if any. */
class NativeSignIn {
  operationId = "";
  private child: ChildProcess | undefined;
  private output = "";
  /** How much output there was when the person last sent a code. */
  private inputAt = -1;
  private exit: number | null | undefined;
  private expiry: NodeJS.Timeout | undefined;
  /** The page step begin answered; every later pending step repeats it. */
  private shown: Step | undefined;

  constructor(private readonly runtime: Runtime) {}

  async begin(operationId: string): Promise<Step> {
    this.cancel();
    endLeftSignIn(this.runtime);
    const child = spawn(command(this.runtime), signInArgs[this.runtime], {
      env: environment(this.runtime),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so ending it ends whatever it started too.
      detached: true,
    });
    recordSignInPid(this.runtime, child.pid);
    this.operationId = operationId;
    this.child = child;
    this.output = "";
    this.inputAt = -1;
    this.exit = undefined;
    // A cancelled sign-in's process can still report after the next began.
    const current = () => this.child === child;
    const take = (chunk: Buffer) => {
      if (current())
        this.output = (this.output + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      if (!current()) return;
      this.output += `\n${error.message}`;
      this.exit = -1;
    });
    child.on("exit", (code) => {
      if (current()) this.exit = code ?? -1;
    });
    this.expiry = setTimeout(() => this.cancel(), signInLifetimeMs);
    this.expiry.unref?.();
    const started = Date.now();
    for (;;) {
      const step = this.page();
      if (step) {
        this.shown = step;
        return step;
      }
      if (this.exit !== undefined) {
        const error = failure(this.output, this.runtime);
        this.finish();
        return { status: "failed", error };
      }
      if (Date.now() - started > waitForPageMs) {
        this.cancel();
        return {
          status: "failed",
          error: "The sign-in did not show its page in time.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  private page(): Step | undefined {
    const expiresAt = new Date(Date.now() + signInLifetimeMs).toISOString();
    if (this.runtime === "claude") {
      const url = parseClaudeLoginPage(this.output);
      return url
        ? {
            status: "pending",
            verificationUrl: url,
            codeEntry: true,
            expiresAt,
          }
        : undefined;
    }
    const found = parseCodexDeviceCode(this.output);
    return found
      ? {
          status: "pending",
          verificationUrl: found.url,
          userCode: found.code,
          expiresAt,
        }
      : undefined;
  }

  running(): boolean {
    return Boolean(this.child);
  }

  input(code: string): void {
    const text = code.trim();
    if (!this.child?.stdin || this.exit !== undefined)
      throw new Error("No sign-in is waiting for a code.");
    if (!text || text.length > 4096 || /\s/.test(text))
      throw new Error("Paste the whole code the page shows, without spaces.");
    this.inputAt = this.output.length;
    this.child.stdin.write(`${text}\n`);
  }

  poll(): Step {
    if (!this.child) return { status: "expired" };
    if (this.exit === undefined) {
      // Claude Code turns a malformed code away and waits for another; end
      // it with its words so the person starts again with a fresh page.
      const reply = this.inputAt >= 0 ? this.output.slice(this.inputAt) : "";
      if (!/invalid code/i.test(reply))
        return this.shown ?? { status: "pending" };
      const error = failure(reply, this.runtime);
      this.cancel();
      return { status: "failed", error };
    }
    const output = this.output;
    const exit = this.exit;
    this.finish();
    clearNativeLoginHealth();
    if (exit === 0) return { status: "complete" };
    return /denied|access_denied/i.test(output)
      ? { status: "denied", error: failure(output, this.runtime) }
      : /expired/i.test(output)
        ? { status: "expired", error: failure(output, this.runtime) }
        : { status: "failed", error: failure(output, this.runtime) };
  }

  cancel(): void {
    if (this.child && this.exit === undefined) {
      const pid = this.child.pid;
      try {
        if (pid) process.kill(-pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch {
        this.child.kill("SIGTERM");
      }
    }
    this.finish();
  }

  private finish(): void {
    clearTimeout(this.expiry);
    this.shown = undefined;
    if (this.child) recordSignInPid(this.runtime, undefined);
    this.child = undefined;
  }
}

const signIns: Record<Runtime, NativeSignIn> = {
  claude: new NativeSignIn("claude"),
  codex: new NativeSignIn("codex"),
};

/** Runs the CLI's own logout; the login it removes is the worker's. */
function signOut(runtime: Runtime): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command(runtime), signOutArgs[runtime], {
      env: environment(runtime),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearNativeLoginHealth();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${runtimeName[runtime]} could not sign out: ${failure(output, runtime)}`,
          ),
        );
    });
  });
}

/** What may cross to the server: an https page, bounded fields. */
function checkedStep(step: Step, operationId: string): NativeSignInStep {
  const clean: NativeSignInStep = { status: step.status, operationId };
  if (step.verificationUrl) {
    const url = new URL(step.verificationUrl);
    if (url.protocol !== "https:")
      throw new Error("the sign-in page is not an https address");
    clean.verificationUrl = url.toString();
  }
  if (step.userCode) clean.userCode = step.userCode.slice(0, 64);
  if (step.codeEntry) clean.codeEntry = true;
  if (step.expiresAt) clean.expiresAt = step.expiresAt;
  if (step.error) clean.error = step.error.slice(0, 300);
  return clean;
}

const operationIdPattern = /^[A-Za-z0-9_-]{16,100}$/;

/**
 * One step of a runtime's sign-in on this device. One sign-in per runtime:
 * a begin replaces a running one, and a step naming another sign-in is told
 * it expired.
 */
export async function nativeSignIn(
  request: NativeSignInRequestPayload,
): Promise<NativeSignInStep | undefined> {
  const runtime = request?.runtime;
  if (runtime !== "claude" && runtime !== "codex")
    throw new Error("Unknown runtime.");
  const signIn = signIns[runtime];
  if (request.action === "sign_out") {
    signIn.cancel();
    await signOut(runtime);
    return undefined;
  }
  const operationId = request.operationId ?? "";
  if (!operationIdPattern.test(operationId))
    throw new Error("A sign-in operation id is required.");
  if (request.action === "begin")
    return checkedStep(await signIn.begin(operationId), operationId);
  if (operationId !== signIn.operationId || !signIn.running())
    return { status: "expired", operationId };
  switch (request.action) {
    case "poll":
      return checkedStep(signIn.poll(), operationId);
    case "input":
      signIn.input(String(request.input ?? ""));
      return checkedStep(signIn.poll(), operationId);
    case "dismiss":
      signIn.cancel();
      return { status: "expired", operationId };
    default:
      throw new Error(`Unknown sign-in action ${String(request.action)}.`);
  }
}
