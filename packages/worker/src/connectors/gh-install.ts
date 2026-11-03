import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { InstallProgress } from "./aws-install.js";
import { downloadFile } from "./download.js";
import { within } from "../platform/paths.js";

/**
 * Installs GitHub CLI for the worker's own user from its official release
 * archives (github.com/cli/cli/releases), never with sudo: the archive's
 * SHA-256 is checked against the release's checksums file, the program is
 * unpacked into ~/.local/share/gh-cli/<version> and linked from Foundry's
 * tools (sessions find it first) and from ~/.local/bin when nothing else is
 * there (the person's terminal finds it too). Downloads go through the
 * device's HTTP(S)_PROXY settings. The result is checked with `gh --version`.
 */

const releasesApi = "https://api.github.com/repos/cli/cli/releases/latest";
const downloadOrigins = [
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
];
const maxDownloadBytes = 200 * 1024 * 1024;

export interface GhInstallOptions {
  managedBin: string;
  progress?: (progress: InstallProgress) => void;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests: the newest version instead of asking GitHub. */
  latestVersion?: () => Promise<string>;
  download?: (url: string, file: string) => Promise<void>;
}

/** The release archive for this machine, or why there is none. */
export function ghArchiveName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
  if (!cpu) throw new Error(`GitHub CLI has no release for ${arch} processors`);
  if (platform === "linux") return `gh_${version}_linux_${cpu}.tar.gz`;
  if (platform === "darwin") return `gh_${version}_macOS_${cpu}.zip`;
  throw new Error(`Foundry installs GitHub CLI on Linux and macOS only`);
}

async function newestVersion(): Promise<string> {
  let response;
  try {
    response = await undiciFetch(releasesApi, {
      dispatcher: new EnvHttpProxyAgent(),
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    throw new Error(
      `could not ask GitHub for the newest GitHub CLI: ${cause?.message ?? (error as Error).message}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `could not ask GitHub for the newest GitHub CLI: HTTP ${response.status}`,
    );
  const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
  const version = typeof tag === "string" ? tag.replace(/^v/, "") : "";
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("GitHub answered without a GitHub CLI version");
  return version;
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

/** The checksum line for name in the release's checksums file. */
export function checksumFor(checksums: string, name: string): string {
  const line = checksums
    .split("\n")
    .map((entry) => entry.trim().split(/\s+/))
    .find(([, file]) => file === name);
  const sum = line?.[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(sum))
    throw new Error(`the release lists no checksum for ${name}`);
  return sum;
}

/** Points `<folder>/<name>` at target, replacing an earlier link only. */
function link(folder: string, name: string, target: string): void {
  mkdirSync(folder, { recursive: true });
  const entry = join(folder, name);
  const staging = `${entry}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, entry);
}

/** ~/.local/bin/gh is free, or a link into our install. */
function binFree(binDir: string, installRoot: string): boolean {
  const entry = join(binDir, "gh");
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return true;
  }
  return (
    stat.isSymbolicLink() &&
    within(installRoot, resolve(binDir, readlinkSync(entry)))
  );
}

export async function installGitHubCli(
  options: GhInstallOptions,
): Promise<{ path: string; version: string }> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchFile =
    options.download ??
    ((url: string, file: string) =>
      downloadFile(url, file, {
        origins: downloadOrigins,
        maxBytes: maxDownloadBytes,
        onBytes: (received, total) =>
          options.progress?.({
            phase: "downloading",
            receivedBytes: received,
            totalBytes: total,
          }),
      }));
  const version = await (options.latestVersion ?? newestVersion)();
  const archive = ghArchiveName(version, platform, arch);
  const base = `https://github.com/cli/cli/releases/download/v${version}`;
  const work = mkdtempSync(join(tmpdir(), "foundry-gh-"));
  try {
    options.progress?.({ phase: "downloading" });
    const checksums = join(work, "checksums.txt");
    await fetchFile(`${base}/gh_${version}_checksums.txt`, checksums);
    const file = join(work, archive);
    await fetchFile(`${base}/${archive}`, file);
    options.progress?.({ phase: "verifying" });
    const expected = checksumFor(readFileSync(checksums, "utf8"), archive);
    const actual = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
    if (actual !== expected)
      throw new Error(`${archive} does not match the release's checksum`);
    options.progress?.({ phase: "installing" });
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    const extract = await run("tar", ["-xf", file, "-C", unpacked]);
    if (extract.code !== 0)
      throw new Error(
        `could not unpack ${archive}: ${extract.stderr.trim().slice(0, 200)}`,
      );
    const folder = archive.replace(/\.(tar\.gz|zip)$/, "");
    const program = join(unpacked, folder, "bin", "gh");
    if (!existsSync(program)) throw new Error(`${archive} holds no bin/gh`);
    const installRoot = join(home, ".local", "share", "gh-cli");
    const target = join(installRoot, version);
    mkdirSync(installRoot, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(join(unpacked, folder), target);
    const installed = join(target, "bin", "gh");
    options.progress?.({ phase: "checking" });
    const check = await run(installed, ["--version"]);
    if (check.code !== 0 || !check.stdout.includes(version))
      throw new Error(
        `the installed gh does not run: ${check.stderr.trim().slice(0, 200)}`,
      );
    link(options.managedBin, "gh", installed);
    const binDir = join(home, ".local", "bin");
    if (binFree(binDir, installRoot)) link(binDir, "gh", installed);
    return { path: join(options.managedBin, "gh"), version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
