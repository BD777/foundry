/** Platform service management. Never detach an unregistered execution owner. */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  processIdentity,
  reapLeftoverAgentProcesses,
} from "../agent-processes.js";
import { workerAppExecutable, workerLauncherPath } from "../mac-worker-app.js";
import { isManagedNativeRuntimePath } from "../native-homes.js";
import { executionHostPaths } from "./paths.js";

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
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ].flatMap((key) => {
      const val = env[key];
      if (!val) return [];
      if (
        (key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR") &&
        isManagedNativeRuntimePath(val)
      ) {
        return [];
      }
      return [[key, val]];
    }),
  );
}

export function prepareExecutionSocket(): void {
  const { root, socketRoot } = executionHostPaths();
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

export async function launchExecutionService(
  entry: string,
  serverURL: string,
): Promise<void> {
  const paths = executionHostPaths();
  prepareExecutionSocket();
  const env = executionServiceEnvironment();
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    // An existing job may be restarting itself. Never boot it out just
    // because its socket is not ready yet.
    try {
      await command("/bin/launchctl", ["print", `${domain}/${paths.label}`]);
      return;
    } catch {}
    let args = [process.execPath, entry, serverURL];
    if (
      existsSync(workerAppExecutable()) &&
      existsSync(workerLauncherPath()) &&
      readFileSync(workerLauncherPath(), "utf8").includes(
        "FOUNDRY_EXECUTION_ENTRY",
      )
    ) {
      args = [workerAppExecutable()];
      Object.assign(env, {
        FOUNDRY_SERVICE_ROLE: "execution",
        FOUNDRY_EXECUTION_NODE: process.execPath,
        FOUNDRY_EXECUTION_ENTRY: entry,
        FOUNDRY_EXECUTION_SERVER: serverURL,
      });
    }
    mkdirSync(dirname(paths.plist), { recursive: true });
    const temp = paths.plist + `.${process.pid}.tmp`;
    writeFileSync(
      temp,
      executionLaunchAgent({
        label: paths.label,
        command: args,
        env,
        root: paths.root,
      }),
      { mode: 0o600 },
    );
    renameSync(temp, paths.plist);
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
  ]);
}

export async function stopExecutionService(): Promise<void> {
  const paths = executionHostPaths();
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
    clearSocket();
    return;
  }
  try {
    await command("systemctl", ["--user", "stop", paths.unit], 20_000);
  } catch (error) {
    if (!/not loaded|not found/.test(String(error))) throw error;
  }
  clearSocket();
}

function clearSocket(): void {
  const paths = executionHostPaths();
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

/** Locate the systemd ownership group on both unified and legacy Linux hosts. */
export function systemdCgroup(
  text: string,
): { group: string; root: string } | undefined {
  const rows = text
    .trim()
    .split("\n")
    .map((line) => line.split(":"));
  const unified = rows.find(
    ([id, controllers]) => id === "0" && controllers === "",
  );
  const legacy = rows.find(([, controllers]) =>
    controllers?.split(",").includes("name=systemd"),
  );
  const group = (unified ?? legacy)?.[2];
  if (!group?.startsWith("/") || group.split("/").includes(".."))
    return undefined;
  return { group, root: unified ? "/sys/fs/cgroup" : "/sys/fs/cgroup/systemd" };
}

/** An old execution service is independent even before it writes owner.json. */
export function executionServiceIsSeparate(
  hostPid: number,
  workerPid: number,
): boolean {
  if (process.platform !== "linux") return false;
  try {
    const host = systemdCgroup(readFileSync(`/proc/${hostPid}/cgroup`, "utf8"));
    const worker = systemdCgroup(
      readFileSync(`/proc/${workerPid}/cgroup`, "utf8"),
    );
    return Boolean(
      host &&
      worker &&
      host.group !== worker.group &&
      host.group.endsWith(`/${executionHostPaths().unit}`),
    );
  } catch {
    return false;
  }
}

/** Upgrade bridge for old Linux hosts that predate the drain handshake. */
export function legacyExecutionHostIsAlone(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const group = systemdCgroup(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    if (!group?.group.endsWith(`/${executionHostPaths().unit}`)) return false;
    const members = readFileSync(
      resolve(group.root, group.group.slice(1), "cgroup.procs"),
      "utf8",
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    return legacyMembersAreIdleCodex(pid, members, (member) => {
      const stat = readFileSync(`/proc/${member}/stat`, "utf8");
      const parent = Number(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
      );
      const argv = readFileSync(`/proc/${member}/cmdline`, "utf8").split("\0");
      return { parent, argv };
    });
  } catch {
    return false;
  }
}

/** Caller already checked no claims, background tasks or own turns in the host snapshot.
 * Old Codex transports can leave child app-servers after completion. Only direct
 * child app-servers with no other processes in the cgroup are safe idle residue.
 * Claude agents and arbitrary tool subprocesses never qualify here.
 */
export function legacyMembersAreIdleCodex(
  hostPid: number,
  members: number[],
  read: (pid: number) => { parent: number; argv: string[] },
): boolean {
  if (!members.includes(hostPid)) return false;
  const processes = new Map(
    members.filter((pid) => pid !== hostPid).map((pid) => [pid, read(pid)]),
  );
  const codex = new Set(
    [...processes]
      .filter(
        ([, process]) =>
          process.parent === hostPid &&
          /^codex(?:\.exe)?$/.test(basename(process.argv[0] ?? "")) &&
          process.argv[1] === "app-server",
      )
      .map(([pid]) => pid),
  );
  return [...processes].every(
    ([pid, process]) =>
      codex.has(pid) ||
      (codex.has(process.parent) &&
        basename(process.argv[0] ?? "") === "codex-code-mode-host"),
  );
}
