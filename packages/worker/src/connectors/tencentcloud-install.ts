import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallProgress } from "./aws-install.js";
import { linkTool, toolLinkFree } from "./tool-links.js";
import { findCommand } from "../skills/managed-tools.js";

/**
 * Installs Tencent Cloud CLI for the worker's own user, never with sudo.
 * tccli is a Python package (pypi.org/project/tccli, the install Tencent
 * documents at cloud.tencent.com/document/product/440/34011); there is no
 * standalone build. Foundry makes a virtual environment with the device's
 * own python3 in ~/.local/share/tccli/<stamp> and installs the newest tccli
 * into it with pip, which uses the device's pip settings (index mirror,
 * proxy) and checks the downloads' hashes against the index. tccli is then
 * linked from Foundry's tools (sessions find it first) and from ~/.local/bin
 * when no other tccli is there or on PATH. The result is checked with
 * `tccli --version`; earlier installs Foundry made are removed after.
 */

export interface TccliInstallOptions {
  managedBin: string;
  progress?: (progress: InstallProgress) => void;
  home?: string;
  /** Tests: the python3 to use instead of finding one. */
  python?: string;
  /** Tests: the PATH whose tccli the ~/.local/bin link must not shadow. */
  path?: string;
  run?: typeof run;
}

function run(
  command: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      },
      (error, stdout, stderr) =>
        done(
          (error as { killed?: boolean } | null)?.killed
            ? { code: 124, stdout: "", stderr: "foundry-step-timeout" }
            : {
                code: error
                  ? typeof (error as { code?: unknown }).code === "number"
                    ? (error as { code: number }).code
                    : 1
                  : 0,
                stdout: String(stdout ?? ""),
                stderr: String(stderr || error?.message || ""),
              },
        ),
    );
  });
}

/** pip's reason in one line, without paths or index credentials. */
export function pipFailure(output: string): string {
  if (output.includes("foundry-step-timeout"))
    return "installing took too long and was stopped; try again when the device is less busy";
  if (/No matching distribution|Could not find a version/i.test(output))
    return "pip found no tccli where this device installs Python packages from";
  if (
    /ConnectTimeout|ConnectionError|Max retries|NewConnectionError|ProxyError|timed out/i.test(
      output,
    )
  )
    return "pip could not reach the Python package index; check the device's network or pip settings";
  if (/ensurepip is not available|No module named venv/i.test(output))
    return "this device's Python has no venv module; install it (on Debian or Ubuntu: python3-venv) and try again";
  if (/No space left/i.test(output)) return "the device has no disk space left";
  return "pip could not install tccli";
}

/** python3, 3.7 or newer, that can make a virtual environment. */
async function findPython(
  options: TccliInstallOptions,
  runner: typeof run,
): Promise<string> {
  const python =
    options.python ??
    findCommand("python3", ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
  if (!python)
    throw new Error(
      "Installing tccli needs Python 3 on this device; install python3 (on macOS: the Xcode Command Line Tools or python.org) and try again.",
    );
  const check = await runner(python, [
    "-c",
    "import sys, venv; print('%d.%d' % sys.version_info[:2])",
  ]);
  const [major, minor] = check.stdout.trim().split(".").map(Number);
  if (check.code !== 0)
    throw new Error(
      `Installing tccli needs Python's venv module: ${pipFailure(check.stderr)}.`,
    );
  if (major !== 3 || (minor ?? 0) < 7)
    throw new Error(
      `tccli needs Python 3.7 or newer; this device has ${check.stdout.trim() || "an unknown version"}.`,
    );
  return python;
}

export async function installTccli(
  options: TccliInstallOptions,
): Promise<{ path: string; version: string }> {
  const runner = options.run ?? run;
  const home = options.home ?? homedir();
  const python = await findPython(options, runner);
  const installRoot = join(home, ".local", "share", "tccli");
  mkdirSync(installRoot, { recursive: true });
  // A virtual environment cannot move (its scripts name their own path), so
  // it is made where it stays, under a fresh name.
  const target = join(installRoot, `env-${Date.now()}`);
  try {
    options.progress?.({ phase: "installing" });
    // ensurepip installs pip into the environment: minutes on a busy device.
    const made = await runner(python, ["-m", "venv", target], 10 * 60_000);
    if (made.code !== 0)
      throw new Error(
        `could not make a Python environment for tccli: ${pipFailure(made.stderr)}`,
      );
    const installed = await runner(
      join(target, "bin", "python"),
      // Without byte-compiling the whole SDK up front: about half the disk
      // and time; Python compiles what tccli imports when it runs.
      [
        "-m",
        "pip",
        "install",
        "--no-input",
        "--no-compile",
        "--upgrade",
        "tccli",
      ],
      20 * 60_000,
    );
    if (installed.code !== 0)
      throw new Error(pipFailure(`${installed.stdout}\n${installed.stderr}`));
    const program = join(target, "bin", "tccli");
    if (!existsSync(program)) throw new Error("pip installed no tccli program");
    options.progress?.({ phase: "checking" });
    const check = await runner(program, ["--version"]);
    const version = /^(\d+\.\d+\.\d+(?:\.\d+)?)\s*$/.exec(
      check.stdout.trim(),
    )?.[1];
    if (check.code !== 0 || !version)
      throw new Error("the installed tccli does not run");
    linkTool(options.managedBin, "tccli", program);
    const binDir = join(home, ".local", "bin");
    if (
      toolLinkFree(
        "tccli",
        binDir,
        installRoot,
        options.managedBin,
        options.path ?? process.env.PATH ?? "",
      )
    )
      linkTool(binDir, "tccli", program);
    // Earlier environments Foundry made; the new links no longer name them.
    for (const entry of readdirSync(installRoot))
      if (entry.startsWith("env-") && join(installRoot, entry) !== target)
        rmSync(join(installRoot, entry), { recursive: true, force: true });
    return { path: join(options.managedBin, "tccli"), version };
  } catch (error) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A step that timed out may still be writing there; the next install
      // removes it with the other earlier environments.
    }
    throw error;
  }
}
