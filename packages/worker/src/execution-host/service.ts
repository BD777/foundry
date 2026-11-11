/** Platform service management. Never detach an unregistered execution owner. */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  processIdentity,
  reapLeftoverAgentProcesses,
} from "../platform/process/agent-processes.js";
import {
  workerAppExecutable,
  workerLauncherPath,
} from "../install/mac-worker-app.js";
import {
  nativeServiceHome,
  nativeSourcePaths,
} from "../harness/native/native-runtime-paths.js";
import { executionHostPaths } from "./paths.js";
import { writeFileAtomic } from "../platform/storage.js";
import { errorMessage } from "../platform/utils.js";

export function executionServiceSupported(): boolean {
  return (
    process.platform === "darwin" ||
    (process.platform === "linux" && !!process.env.XDG_RUNTIME_DIR)
  );
}

export function runtimeStamp(entry: string): string {
  return `${entry}:${statSync(entry).mtimeMs}`;
}

// These describe the device's execution environment, not a particular run.
// Dispatch/session credentials must never be copied into a service manifest.
export function executionServiceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "LANG",
      "LC_ALL",
      "TZ",
      "FOUNDRY_STATE_ROOT",
      "FOUNDRY_STACK",
      "FOUNDRY_TOOLS_ROOT",
      "FOUNDRY_CODEX_BIN",
      "FOUNDRY_CLAUDE_BIN",
      "FOUNDRY_CLAUDE_MAX_TURNS",
      "CODEX_HOME",
      "CODEX_CLI_PATH",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME",
      "FOUNDRY_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ].flatMap((key) => {
      const val =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR"
          ? nativeServiceHome(key === "CODEX_HOME" ? "codex" : "claude", env)
          : key === "CLAUDE_SECURESTORAGE_CONFIG_DIR"
            ? nativeSourcePaths("claude", env).credentialNamespace
            : env[key];
      if (
        val === undefined ||
        (val === "" && key !== "CLAUDE_SECURESTORAGE_CONFIG_DIR")
      )
        return [];
      return [[key, val]];
    }),
  );
}

export function prepareExecutionSocket(paths = executionHostPaths()): void {
  const { root, socketRoot } = paths;
  for (const path of new Set([root, socketRoot])) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Execution service directory must belong to this user and cannot be a symlink.",
      );
    chmodSync(path, 0o700);
  }
}

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function executionLaunchAgent(input: {
  label: string;
  command: string[];
  env: Record<string, string>;
  root: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(input.label)}</string>
<key>ProgramArguments</key><array>${input.command.map((v) => `<string>${xml(v)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(input.env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>2</integer><key>ExitTimeOut</key><integer>10</integer>
<key>AbandonProcessGroup</key><false/>
<key>WorkingDirectory</key><string>${xml(input.root)}</string>
<key>StandardOutPath</key><string>${xml(resolve(input.root, "service.out.log"))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(input.root, "service.err.log"))}</string>
</dict></plist>\n`;
}

function command(
  bin: string,
  args: string[],
  timeout = 15_000,
): Promise<string> {
  return new Promise((done, reject) =>
    execFile(bin, args, { timeout }, (error, stdout, stderr) =>
      error
        ? reject(
            new Error(
              `${bin} ${args[0]} failed: ${stderr.trim() || String(error.code ?? "unknown error")}`,
            ),
          )
        : done(stdout),
    ),
  );
}

/** A host beside the original one is told its own root; the original is not. */
function rootArguments(paths: ReturnType<typeof executionHostPaths>): string[] {
  return paths.root === executionHostPaths().root ? [] : [paths.root];
}

let warnedDirectLaunch = false;
/**
 * The installed launcher predates FOUNDRY_EXECUTION_ROOT, so a host beside the
 * original one starts as a plain node process, without the Foundry app identity
 * that macOS privacy grants (screen, accessibility, files) are tied to. The
 * launcher is rewritten by the next install or update of the Worker app.
 */
function warnDirectLaunch(): void {
  if (warnedDirectLaunch) return;
  warnedDirectLaunch = true;
  console.error(
    "Execution host starts without the Foundry app launcher (the installed launcher is older than host rollover): macOS privacy grants made to Foundry do not apply to it. Run `foundry-worker update` or `install` to rewrite the launcher.",
  );
}

export async function launchExecutionService(
  entry: string,
  serverURL: string,
  paths = executionHostPaths(),
): Promise<void> {
  prepareExecutionSocket(paths);
  const env = executionServiceEnvironment();
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    // An existing job may be restarting itself. Never boot it out just
    // because its socket is not ready yet.
    try {
      await command("/bin/launchctl", ["print", `${domain}/${paths.label}`]);
      return;
    } catch {}
    let args = [process.execPath, entry, serverURL, ...rootArguments(paths)];
    if (
      existsSync(workerAppExecutable()) &&
      existsSync(workerLauncherPath()) &&
      readFileSync(workerLauncherPath(), "utf8").includes(
        "FOUNDRY_EXECUTION_ENTRY",
      ) &&
      // An older launcher cannot pass the root of a host beside another.
      (!rootArguments(paths).length ||
        readFileSync(workerLauncherPath(), "utf8").includes(
          "FOUNDRY_EXECUTION_ROOT",
        ))
    ) {
      args = [workerAppExecutable()];
      Object.assign(env, {
        FOUNDRY_SERVICE_ROLE: "execution",
        FOUNDRY_EXECUTION_NODE: process.execPath,
        FOUNDRY_EXECUTION_ENTRY: entry,
        FOUNDRY_EXECUTION_SERVER: serverURL,
        ...(rootArguments(paths)[0]
          ? { FOUNDRY_EXECUTION_ROOT: rootArguments(paths)[0]! }
          : {}),
      });
    }
    if (
      args[0] === process.execPath &&
      rootArguments(paths).length &&
      existsSync(workerAppExecutable())
    )
      warnDirectLaunch();
    writeFileAtomic(
      paths.plist,
      executionLaunchAgent({
        label: paths.label,
        command: args,
        env,
        root: paths.root,
      }),
      { directoryMode: 0o755, hardenParent: false },
    );
    await command("/bin/launchctl", ["enable", `${domain}/${paths.label}`]);
    await command("/bin/launchctl", ["bootstrap", domain, paths.plist]);
    return;
  }
  try {
    const loaded = await command("systemctl", [
      "--user",
      "show",
      paths.unit,
      "--property=LoadState",
      "--value",
    ]);
    if (loaded.trim() === "loaded") {
      await command("systemctl", ["--user", "start", paths.unit]);
      return;
    }
  } catch {
    /* no existing registered unit */
  }
  await command("systemd-run", [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${paths.unit}`,
    "--service-type=exec",
    "--property=KillMode=control-group",
    "--property=Restart=on-failure",
    "--property=RestartSec=1s",
    "--property=TimeoutStopSec=10s",
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
    process.execPath,
    entry,
    serverURL,
    ...rootArguments(paths),
  ]);
}

export async function stopExecutionService(
  paths = executionHostPaths(),
): Promise<void> {
  if (process.platform === "darwin") {
    // The app's PID and the Node execution owner's PID are not the same.
    // launchd removes the job, then any surviving recorded owner is stopped
    // by exact process identity, never by a name or reused PID.
    let identity: { pid: number; startTime: string } | undefined;
    try {
      identity = JSON.parse(
        readFileSync(resolve(paths.root, "identity.json"), "utf8"),
      );
    } catch {}
    const target = `gui/${process.getuid!()}/${paths.label}`;
    try {
      await command("/bin/launchctl", ["bootout", target], 20_000);
    } catch (error) {
      // If it remains registered, fail closed instead of starting a duplicate.
      let exists = false;
      try {
        await command("/bin/launchctl", ["print", target]);
        exists = true;
      } catch {}
      if (exists) throw error;
    }
    if (
      identity &&
      processIdentity(identity.pid)?.startTime === identity.startTime
    ) {
      process.kill(identity.pid, "SIGTERM");
      for (
        let i = 0;
        i < 40 &&
        processIdentity(identity.pid)?.startTime === identity.startTime;
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      if (processIdentity(identity.pid)?.startTime === identity.startTime)
        process.kill(identity.pid, "SIGKILL");
    }
    await reapLeftoverAgentProcesses();
    try {
      unlinkSync(paths.plist);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    clearSocket(paths);
    return;
  }
  try {
    await command("systemctl", ["--user", "stop", paths.unit], 20_000);
  } catch (error) {
    if (!/not loaded|not found/.test(String(error))) throw error;
  }
  clearSocket(paths);
}

/**
 * Replaces a runner whose process lives but does not answer: its job is
 * stopped, then the recorded owner, if it survived, is ended by exact
 * identity (TERM, then KILL after the grace). Its turns cannot progress.
 */
export async function reclaimExecutionService(
  stop: () => Promise<void> = stopExecutionService,
  identityPath = resolve(executionHostPaths().root, "identity.json"),
  graceMs = 5000,
): Promise<void> {
  let identity: { pid: number; startTime: string } | undefined;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch {}
  try {
    await stop();
  } catch (error) {
    console.error(
      `Stopping the unanswering execution service: ${errorMessage(error)}`,
    );
  }
  if (!identity?.pid) return;
  const alive = () =>
    processIdentity(identity!.pid)?.startTime === identity!.startTime;
  for (const [signal, waitMs] of [
    ["SIGTERM", graceMs],
    ["SIGKILL", 2000],
  ] as const) {
    if (!alive()) return;
    try {
      process.kill(identity.pid, signal);
    } catch {}
    for (let waited = 0; waited < waitMs && alive(); waited += 100)
      await new Promise((r) => setTimeout(r, 100));
  }
  if (alive())
    throw new Error(
      `The unanswering execution host ${identity.pid} survived SIGKILL.`,
    );
}

function clearSocket(paths = executionHostPaths()): void {
  try {
    unlinkSync(paths.socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (paths.socketRoot !== paths.root)
    try {
      rmdirSync(paths.socketRoot);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
}
