import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallProgress } from "./aws-install.js";
import { downloadFile, failureText, fetchRetrying } from "./download.js";
import { linkTool, toolLinkFree } from "./tool-links.js";

/**
 * Installs GitHub CLI for the worker's own user from its official release
 * archives (github.com/cli/cli/releases), never with sudo: the archive's
 * SHA-256 is checked against the release's checksums file, the program is
 * unpacked into ~/.local/share/gh-cli/<version> and linked from Foundry's
 * tools (sessions find it first) and from ~/.local/bin when no other gh is
 * there or on PATH (the person's terminal finds it too). Downloads use the
 * Worker's saved outbound proxy (or its environment fallback). The result is
 * checked with `gh --version`.
 */

// The page redirects to the newest release's tag. Unlike api.github.com it
// has no per-address limit, which a company's shared egress address uses up.
const latestRelease = "https://github.com/cli/cli/releases/latest";
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
  /** Tests: the PATH whose gh the ~/.local/bin link must not shadow. */
  path?: string;
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

/** The version in the newest release's tag page address. */
export function versionFromReleaseLocation(location: string): string {
  const version =
    /\/cli\/cli\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(location)?.[1] ?? "";
  if (!version) throw new Error("GitHub answered without a GitHub CLI version");
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
      `could not ask GitHub for the newest GitHub CLI: ${failureText(error)}`,
    );
  }
  if (response.status < 300 || response.status >= 400)
    throw new Error(
      `could not ask GitHub for the newest GitHub CLI: HTTP ${response.status}`,
    );
  return versionFromReleaseLocation(response.headers.get("location") ?? "");
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
  // Stage inside the install root: renaming the unpacked folder into place
  // must not cross filesystems (/tmp is often a tmpfs; rename gives EXDEV).
  const installRoot = join(home, ".local", "share", "gh-cli");
  mkdirSync(installRoot, { recursive: true });
  const work = mkdtempSync(join(installRoot, ".staging-"));
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
    const target = join(installRoot, version);
    rmSync(target, { recursive: true, force: true });
    renameSync(join(unpacked, folder), target);
    const installed = join(target, "bin", "gh");
    options.progress?.({ phase: "checking" });
    const check = await run(installed, ["--version"]);
    if (check.code !== 0 || !check.stdout.includes(version))
      throw new Error(
        `the installed gh does not run: ${check.stderr.trim().slice(0, 200)}`,
      );
    linkTool(options.managedBin, "gh", installed);
    const binDir = join(home, ".local", "bin");
    if (
      toolLinkFree(
        "gh",
        binDir,
        installRoot,
        options.managedBin,
        options.path ?? process.env.PATH ?? "",
      )
    )
      linkTool(binDir, "gh", installed);
    return { path: join(options.managedBin, "gh"), version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
