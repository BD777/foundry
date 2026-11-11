import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallProgress } from "./aws-install.js";
import { downloadFile, failureText, fetchRetrying } from "./download.js";
import { checksumFor } from "./gh-install.js";
import { linkTool, toolLinkFree } from "./tool-links.js";

/**
 * Installs Alibaba Cloud CLI (github.com/aliyun/aliyun-cli) for the
 * worker's own user, never with sudo. The release is one static program
 * in a tgz (help.aliyun.com/zh/cli/install-cli-on-linux). The newest version
 * and the release's SHASUMS256.txt come from GitHub; the archive from Alibaba's
 * own CDN (aliyuncli.alicdn.com, the documented download, fast inside
 * mainland China) with GitHub as the fallback, checked against the sum
 * either way. The program goes to ~/.local/share/aliyun-cli/<version>/aliyun
 * and is linked from Foundry's tools (sessions find it first) and from
 * ~/.local/bin when no other aliyun is there or on PATH. Downloads use the
 * Worker's saved outbound proxy (or its environment fallback); the result is
 * checked with `aliyun version`.
 */

const latestRelease = "https://github.com/aliyun/aliyun-cli/releases/latest";
const githubOrigins = [
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
];
const cdn = "https://aliyuncli.alicdn.com";
const maxDownloadBytes = 200 * 1024 * 1024;

export interface AliyunInstallOptions {
  managedBin: string;
  progress?: (progress: InstallProgress) => void;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests: the newest version instead of asking GitHub. */
  latestVersion?: () => Promise<string>;
  download?: (url: string, file: string) => Promise<void>;
  /** Tests: the PATH whose aliyun the ~/.local/bin link must not shadow. */
  path?: string;
}

/** The release archive for this machine, or why there is none. */
export function aliyunArchiveName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
  if (!cpu)
    throw new Error(`Alibaba Cloud CLI has no release for ${arch} processors`);
  if (platform === "linux") return `aliyun-cli-linux-${version}-${cpu}.tgz`;
  if (platform === "darwin") return `aliyun-cli-macosx-${version}-${cpu}.tgz`;
  throw new Error("Foundry installs Alibaba Cloud CLI on Linux and macOS only");
}

export function aliyunVersionFromLocation(location: string): string {
  const version =
    /\/aliyun\/aliyun-cli\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(
      location,
    )?.[1] ?? "";
  if (!version)
    throw new Error("GitHub answered without an Alibaba Cloud CLI version");
  return version;
}

async function newestVersion(): Promise<string> {
  let response;
  try {
    response = await fetchRetrying(latestRelease, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `could not ask GitHub for the newest Alibaba Cloud CLI: ${failureText(error)}`,
    );
  }
  if (response.status < 300 || response.status >= 400)
    throw new Error(
      `could not ask GitHub for the newest Alibaba Cloud CLI: HTTP ${response.status}`,
    );
  return aliyunVersionFromLocation(response.headers.get("location") ?? "");
}

function run(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error
            ? typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1
            : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr || error?.message || ""),
        }),
    );
  });
}

export async function installAliyunCli(
  options: AliyunInstallOptions,
): Promise<{ path: string; version: string }> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchFile =
    options.download ??
    ((url: string, file: string) =>
      downloadFile(url, file, {
        origins: [...githubOrigins, cdn],
        maxBytes: maxDownloadBytes,
        onBytes: (received, total) =>
          options.progress?.({
            phase: "downloading",
            receivedBytes: received,
            totalBytes: total,
          }),
      }));
  const version = await (options.latestVersion ?? newestVersion)();
  const archive = aliyunArchiveName(version, platform, arch);
  const release = `https://github.com/aliyun/aliyun-cli/releases/download/v${version}`;
  const work = mkdtempSync(join(tmpdir(), "foundry-aliyun-"));
  try {
    options.progress?.({ phase: "downloading" });
    const sums = join(work, "SHASUMS256.txt");
    await fetchFile(`${release}/SHASUMS256.txt`, sums);
    const expected = checksumFor(readFileSync(sums, "utf8"), archive);
    const file = join(work, archive);
    const sha = () =>
      createHash("sha256").update(readFileSync(file)).digest("hex");
    let fromCdn = false;
    try {
      await fetchFile(`${cdn}/${archive}`, file);
      fromCdn = sha() === expected;
    } catch {
      fromCdn = false;
    }
    if (!fromCdn) {
      rmSync(file, { force: true });
      await fetchFile(`${release}/${archive}`, file);
    }
    options.progress?.({ phase: "verifying" });
    if (sha() !== expected)
      throw new Error(`${archive} does not match the release's checksum`);
    options.progress?.({ phase: "installing" });
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    const extract = await run("tar", ["-xzf", file, "-C", unpacked, "aliyun"]);
    const program = join(unpacked, "aliyun");
    if (extract.code !== 0 || !existsSync(program))
      throw new Error(`${archive} holds no aliyun program`);
    chmodSync(program, 0o755);
    const installRoot = join(home, ".local", "share", "aliyun-cli");
    const target = join(installRoot, version);
    mkdirSync(installRoot, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target);
    renameSync(program, join(target, "aliyun"));
    const installed = join(target, "aliyun");
    options.progress?.({ phase: "checking" });
    const check = await run(installed, ["version"]);
    if (check.code !== 0 || check.stdout.trim() !== version)
      throw new Error("the installed aliyun does not run");
    linkTool(options.managedBin, "aliyun", installed);
    const binDir = join(home, ".local", "bin");
    if (
      toolLinkFree(
        "aliyun",
        binDir,
        installRoot,
        options.managedBin,
        options.path ?? process.env.PATH ?? "",
      )
    )
      linkTool(binDir, "aliyun", installed);
    // Earlier versions Foundry installed; the new links no longer name them.
    for (const entry of readdirSync(installRoot))
      if (entry !== version && /^\d+\.\d+\.\d+$/.test(entry))
        rmSync(join(installRoot, entry), { recursive: true, force: true });
    return { path: join(options.managedBin, "aliyun"), version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
