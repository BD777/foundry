import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureProcess,
  type CommandInvocation,
  type CommandOutput,
} from "./evidence-collectors.js";

/** Only the frozen candidate, checker and output are exposed. Network is denied. */
export async function runEvidenceCommand(
  invocation: CommandInvocation,
  candidate: string,
  output: string,
): Promise<CommandOutput> {
  const systemRoots = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
  ].filter(existsSync);
  if (process.platform === "darwin") {
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target self))",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read-metadata)",
      '(allow file-read-data (literal "/") (subpath "/private/etc") (subpath "/private/var/db"))',
      '(allow file-read-data (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
      '(allow file-write* (literal "/dev/null"))',
      ...[...systemRoots, candidate, output].map(
        (path) => `(allow file-read-data (subpath ${JSON.stringify(path)}))`,
      ),
      `(allow file-write* (subpath ${JSON.stringify(output)}))`,
      `(deny file-write* (subpath ${JSON.stringify(resolve(output, "checker"))}))`,
    ].join("\n");
    const path = resolve(output, "..", "checker.sb");
    writeFileSync(path, profile, { mode: 0o600 });
    return captureProcess({
      ...invocation,
      executable: "/usr/bin/sandbox-exec",
      args: ["-f", path, invocation.executable, ...invocation.args],
      env: {
        ...invocation.env,
        HOME: output,
        TMPDIR: output,
        TMP: output,
        TEMP: output,
      },
    });
  }
  if (process.platform === "linux" && existsSync("/usr/bin/bwrap")) {
    const args = [
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--tmpfs",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
    ];
    for (const root of systemRoots) args.push("--ro-bind", root, root);
    args.push(
      "--ro-bind",
      candidate,
      candidate,
      "--bind",
      output,
      output,
      "--ro-bind",
      resolve(output, "checker"),
      resolve(output, "checker"),
      "--chdir",
      invocation.cwd,
      "--",
      invocation.executable,
      ...invocation.args,
    );
    return captureProcess({
      ...invocation,
      executable: "/usr/bin/bwrap",
      args,
      env: {
        ...invocation.env,
        HOME: output,
        TMPDIR: output,
        TMP: output,
        TEMP: output,
      },
    });
  }
  throw new Error("verification_isolation_unavailable");
}
