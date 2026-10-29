/**
 * Setting an external connection up on this device from Foundry
 * (docs/external-connections.md, "Setup on another device").
 *
 * - A gateway's installer reports its steps with `foundry-worker connection
 *   progress`; the latest step per connection is kept here for an hour.
 * - "Set it up for me" runs the setup command the gateway registered on one
 *   of the person's other devices, here, as this worker's account. The
 *   server takes the command from its own record, never from a request,
 *   and the worker refuses while its owner has remote commands off.
 *
 * Foundry never downloads or installs anything itself: the command is the
 * gateway's, shown to the person before it runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExternalConnectionSetupInfo,
  ExternalConnectionSetupProgress,
  ExternalConnectionSetupProgressState,
  ExternalConnectionSetupRun,
  ExternalConnectionSignIn,
} from "@bd777/foundry-protocol";
import { ExternalConnectionError } from "./external-connection-registry.js";
import { signalChildGroup } from "./process-group.js";
import { redactSecrets } from "./secret-redaction.js";
import { foundryStatePath } from "./state-root.js";
import { tryReadJSONFile, writePrivateJSONAtomic } from "./storage.js";
import { safeID } from "./utils.js";

const maxCommandLength = 2000;
const maxURLLength = 2000;
const progressTTLms = 60 * 60 * 1000;
/** A run's output kept for reading; older output is dropped. */
const maxRunOutput = 256 * 1024;
/** Sign-in waits for a person, so a run may take a while. */
const runTimeoutMs = 20 * 60 * 1000;
const killGraceMs = 5000;
const finishedRunTTLms = 60 * 60 * 1000;

const signInModes: ExternalConnectionSignIn[] = [
  "device_code",
  "browser",
  "none",
];
const progressStates: ExternalConnectionSetupProgressState[] = [
  "installing",
  "installed",
  "waiting_sign_in",
  "signed_in",
  "failed",
];

function invalid(message: string): ExternalConnectionError {
  return new ExternalConnectionError("invalid_input", message);
}

function httpsURL(value: string, what: string): string {
  const text = value.trim();
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || text.length > maxURLLength)
    throw invalid(`${what} must be an https URL.`);
  return text;
}

/** One line a shell runs; the gateway's, never containing secrets. */
export function validSetupCommand(value: string): string {
  const command = value.trim();
  if (!command || command.length > maxCommandLength || /[\r\n\0]/.test(command))
    throw invalid(
      `The setup command must be one line of at most ${maxCommandLength} characters.`,
    );
  return command;
}

/** Setup metadata from `connection add`; none at all is fine. */
export function externalSetupInfo(input: {
  command?: string;
  url?: string;
  signIn?: string;
}): ExternalConnectionSetupInfo | undefined {
  const command = input.command?.trim() ?? "";
  const url = input.url?.trim() ?? "";
  const signIn = input.signIn?.trim() ?? "";
  if (!command) {
    if (url || signIn)
      throw invalid("--setup-url and --sign-in need a --setup-command.");
    return undefined;
  }
  if (signIn && !signInModes.includes(signIn as ExternalConnectionSignIn))
    throw invalid(`--sign-in is one of ${signInModes.join(", ")}.`);
  return {
    command: validSetupCommand(command),
    ...(url ? { url: httpsURL(url, "--setup-url") } : {}),
    ...(signIn ? { signIn: signIn as ExternalConnectionSignIn } : {}),
  };
}

// --- Progress an installer reports ---------------------------------------

function progressPath(): string {
  return foundryStatePath("external-connection-setup.json");
}

type ProgressFile = Record<string, ExternalConnectionSetupProgress>;

function readProgress(now = Date.now()): ProgressFile {
  const value = tryReadJSONFile<ProgressFile>(progressPath());
  const fresh: ProgressFile = {};
  if (!value || typeof value !== "object") return fresh;
  for (const [id, entry] of Object.entries(value)) {
    const at = Date.parse(entry?.updatedAt ?? "");
    if (Number.isFinite(at) && now - at < progressTTLms) fresh[id] = entry;
  }
  return fresh;
}

export interface SetupProgressInput {
  id: string;
  state: string;
  signInUrl?: string;
  userCode?: string;
  message?: string;
}

/** `foundry-worker connection progress`: the step an installer reached. */
export function reportSetupProgress(
  input: SetupProgressInput,
): ExternalConnectionSetupProgress {
  const id = input.id?.trim() ?? "";
  if (!id || id.length > 64 || safeID(id) !== id)
    throw invalid(
      "The connection id must be 1-64 lowercase letters, digits or single underscores.",
    );
  const state = input.state?.trim() as ExternalConnectionSetupProgressState;
  if (!progressStates.includes(state))
    throw invalid(`--state is one of ${progressStates.join(", ")}.`);
  const userCode = input.userCode?.trim() ?? "";
  if (userCode && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(userCode))
    throw invalid(
      "--user-code is at most 64 letters, digits, spaces, dashes or underscores.",
    );
  const message = (input.message ?? "").replace(/\s+/g, " ").trim();
  if (message.length > 500)
    throw invalid("--message is at most 500 characters.");
  const progress: ExternalConnectionSetupProgress = {
    profileId: id,
    state,
    updatedAt: new Date().toISOString(),
    ...(input.signInUrl?.trim()
      ? { signInUrl: httpsURL(input.signInUrl, "--sign-in-url") }
      : {}),
    ...(userCode ? { userCode } : {}),
    ...(message ? { message } : {}),
  };
  writePrivateJSONAtomic(progressPath(), { ...readProgress(), [id]: progress });
  return progress;
}

export function currentSetupProgress(
  id: string,
): ExternalConnectionSetupProgress | undefined {
  return readProgress()[id];
}

export function forgetSetupProgress(id: string): void {
  const progress = readProgress();
  if (!(id in progress)) return;
  delete progress[id];
  writePrivateJSONAtomic(progressPath(), progress);
}

// --- Set it up for me ------------------------------------------------------

interface SetupRunRecord {
  run: Omit<ExternalConnectionSetupRun, "output" | "offset" | "nextOffset">;
  output: string;
  /** Characters dropped from the front. */
  dropped: number;
  child?: ChildProcess;
  cancelled?: boolean;
  timedOut?: boolean;
}

const runs = new Map<string, SetupRunRecord>();

function pruneRuns(now = Date.now()): void {
  for (const [runId, record] of runs) {
    const ended = Date.parse(record.run.endedAt ?? "");
    if (Number.isFinite(ended) && now - ended > finishedRunTTLms)
      runs.delete(runId);
  }
}

function append(record: SetupRunRecord, text: string): void {
  record.output += text;
  const excess = record.output.length - maxRunOutput;
  if (excess > 0) {
    record.output = record.output.slice(excess);
    record.dropped += excess;
  }
}

/**
 * The `foundry-worker` an installer should call: the installed command
 * (`shim`), or for a worker run from a source checkout, a small script that
 * runs it.
 */
export function setupWorkerCommand(shim: string): string {
  if (existsSync(shim)) return shim;
  const script = foundryStatePath("connection-setup", "foundry-worker");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(
    script,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
  );
  chmodSync(script, 0o700);
  return script;
}

const passedVariables =
  /^(HOME|USER|LOGNAME|SHELL|PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|XDG_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|FOUNDRY_STATE_ROOT|FOUNDRY_STACK|https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY)$/;

/**
 * What the command sees: the account's ordinary environment, without this
 * worker's own credentials or server connection.
 */
export function setupEnvironment(
  profileId: string,
  workerCommand: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && passedVariables.test(name)) env[name] = value;
  return {
    ...env,
    HOME: env.HOME ?? homedir(),
    TERM: "dumb",
    NO_COLOR: "1",
    FOUNDRY_WORKER: workerCommand,
    FOUNDRY_CONNECTION_SETUP: "remote",
    FOUNDRY_CONNECTION_ID: profileId,
  };
}

function setupShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL;
  return shell && isAbsolute(shell) && existsSync(shell) ? shell : "/bin/sh";
}

function runningFor(profileId: string): SetupRunRecord | undefined {
  return [...runs.values()].find(
    (record) =>
      record.run.profileId === profileId && record.run.state === "running",
  );
}

/**
 * Starts the registered setup command; one at a time per connection.
 * `remoteCommands` is the owner's setting as this worker enforces it.
 */
export function startSetupRun(
  profileId: string,
  command: string,
  options: {
    remoteCommands: boolean;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): ExternalConnectionSetupRun {
  if (!options.remoteCommands)
    throw new ExternalConnectionError(
      "remote_commands_off",
      "Remote commands are off on this device; its owner can turn them on in Foundry's Resources page.",
    );
  if (process.platform === "win32")
    throw invalid("Setting a connection up from Foundry needs a POSIX shell.");
  const id = profileId?.trim() ?? "";
  if (!id || safeID(id) !== id) throw invalid("Unknown connection id.");
  const line = validSetupCommand(command ?? "");
  if (runningFor(id))
    throw new ExternalConnectionError(
      "busy",
      "This connection is already being set up on this device.",
    );
  pruneRuns();
  const env = options.env;
  const record: SetupRunRecord = {
    run: {
      runId: `setup_${randomUUID()}`,
      profileId: id,
      state: "running",
      startedAt: new Date().toISOString(),
    },
    output: "",
    dropped: 0,
  };
  runs.set(record.run.runId, record);
  const child = spawn(setupShell(env), ["-lc", line], {
    cwd: env.HOME ?? homedir(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  record.child = child;
  const take = (chunk: Buffer) =>
    append(record, redactSecrets(chunk.toString()));
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  const timer = setTimeout(() => {
    record.timedOut = true;
    stop(record);
  }, options.timeoutMs ?? runTimeoutMs);
  timer.unref();
  const finish = (code: number | null, error?: Error) => {
    if (record.run.state !== "running") return;
    clearTimeout(timer);
    record.child = undefined;
    if (error) append(record, `\n${error.message}\n`);
    record.run = {
      ...record.run,
      state: record.cancelled
        ? "cancelled"
        : record.timedOut
          ? "timed_out"
          : code === 0
            ? "succeeded"
            : "failed",
      endedAt: new Date().toISOString(),
      ...(code !== null ? { exitCode: code } : {}),
    };
  };
  child.once("error", (error) => finish(null, error));
  child.once("close", (code) => finish(code));
  return readSetupRun(id, record.run.runId)!;
}

function stop(record: SetupRunRecord): void {
  const child = record.child;
  if (!child) return;
  signalChildGroup(child, "SIGTERM");
  setTimeout(() => {
    if (record.child) signalChildGroup(child, "SIGKILL");
  }, killGraceMs).unref();
}

/** A run's state and its output from `after` on; the latest run by default. */
export function readSetupRun(
  profileId: string,
  runId?: string,
  after = 0,
): ExternalConnectionSetupRun | undefined {
  pruneRuns();
  const record = runId
    ? runs.get(runId)
    : [...runs.values()]
        .filter((item) => item.run.profileId === profileId)
        .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))
        .at(-1);
  if (!record || record.run.profileId !== profileId) return undefined;
  const end = record.dropped + record.output.length;
  const from = Math.min(Math.max(after, record.dropped), end);
  return {
    ...record.run,
    output: record.output.slice(from - record.dropped),
    offset: from,
    nextOffset: end,
    ...(after < record.dropped ? { truncated: true } : {}),
  };
}

export function cancelSetupRun(
  profileId: string,
  runId: string,
): ExternalConnectionSetupRun {
  const record = runs.get(runId);
  if (!record || record.run.profileId !== profileId)
    throw new ExternalConnectionError(
      "not_found",
      "No such setup run on this device.",
    );
  if (record.run.state === "running") {
    record.cancelled = true;
    stop(record);
  }
  return readSetupRun(profileId, runId, Number.MAX_SAFE_INTEGER)!;
}
