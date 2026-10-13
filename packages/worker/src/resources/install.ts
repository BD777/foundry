// install_resource_backend: installs a backend the person chose to install,
// with its official installer, on this device only. cua-driver's installer
// (no prompts, no sudo) puts CuaDriver.app in /Applications and links
// ~/.local/bin/cua-driver; it runs with telemetry off and without editing
// shell rc files, and telemetry is then disabled for good.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cuaDriverBackend,
  type ResourceBackendInstallRequest,
  type ResourceBackendInstallResult,
} from "@bd777/foundry-protocol";
import {
  cuaDriverEnv,
  cuaDriverInstallerUrl,
  resolveCuaDriverBinary,
  runBounded,
  type CommandRunner,
} from "./cua-driver-host.js";
import { runDetector } from "./detector.js";
import { cuaDriverScreenControlDetector } from "./detectors/computer-use-cua-driver.js";

export const installTimeoutMs = 10 * 60_000;
const outputTailBytes = 8 * 1024;

export interface InstallOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  resolveBinary?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** A private folder for the downloaded installer. */
  makeTempDir?: () => Promise<string>;
  /** What the backend still misses, detected again. */
  missing?: () => Promise<string[]>;
}

let installing: Promise<ResourceBackendInstallResult> | undefined;

/** Installs a backend; one install at a time (a second waits for it). */
export function installResourceBackend(
  request: ResourceBackendInstallRequest,
  options: InstallOptions = {},
): Promise<ResourceBackendInstallResult> {
  if (installing) return installing;
  installing = install(request, options).finally(() => {
    installing = undefined;
  });
  return installing;
}

async function install(
  request: ResourceBackendInstallRequest,
  options: InstallOptions,
): Promise<ResourceBackendInstallResult> {
  const backend = request?.backend ?? "";
  const platform = options.platform ?? process.platform;
  if (backend !== cuaDriverBackend)
    return {
      backend,
      ok: false,
      error: `Foundry cannot install ${backend || "(unnamed)"}`,
    };
  if (platform !== "darwin")
    return { backend, ok: false, error: "cua-driver installs on macOS only" };
  const run = options.run ?? runBounded;
  const env = cuaDriverEnv(options.env ?? process.env);
  const folder = await (
    options.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "foundry-install-")))
  )();
  const output: string[] = [];
  try {
    const script = join(folder, "install.sh");
    const download = await run(
      "/usr/bin/curl",
      ["-fsSL", "--proto", "=https", "-o", script, cuaDriverInstallerUrl],
      { env, timeoutMs: 2 * 60_000, maxOutputBytes: 64 * 1024 },
    );
    if (download.code !== 0)
      return {
        backend,
        ok: false,
        error: `could not download ${cuaDriverInstallerUrl}: ${download.stderr.trim() || (download.timedOut ? "timed out" : `curl exit ${download.code}`)}`,
      };
    const installed = await run("/bin/bash", [script], {
      env,
      timeoutMs: installTimeoutMs,
      maxOutputBytes: 1 << 20,
    });
    output.push(installed.stdout, installed.stderr);
    if (installed.code !== 0)
      return {
        backend,
        ok: false,
        output: tail(output),
        error: installed.timedOut
          ? `the cua-driver installer ran past ${installTimeoutMs / 60_000} minutes`
          : `the cua-driver installer failed (exit ${installed.code})`,
      };
    const binary = (
      options.resolveBinary ?? ((e) => resolveCuaDriverBinary(e, platform))
    )(env);
    if (!binary)
      return {
        backend,
        ok: false,
        output: tail(output),
        error: "the installer finished but cua-driver was not found",
      };
    const telemetry = await run(binary, ["telemetry", "disable"], {
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (telemetry.code !== 0)
      output.push(
        `cua-driver telemetry disable failed (exit ${telemetry.code}): ${telemetry.stderr.trim()}; DO_NOT_TRACK still keeps Foundry's runs silent.`,
      );
    const missing = await (
      options.missing ?? (() => cuaDriverMissing(platform))
    )();
    return { backend, ok: true, output: tail(output), missing };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** What the cua-driver detector still reports missing. */
async function cuaDriverMissing(platform: NodeJS.Platform): Promise<string[]> {
  const outcome = await runDetector(cuaDriverScreenControlDetector, {
    platform,
  });
  return outcome.instances[0]?.readiness.missing ?? [];
}

function tail(parts: string[]): string {
  const text = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= outputTailBytes
    ? text
    : bytes.subarray(bytes.length - outputTailBytes).toString("utf8");
}
