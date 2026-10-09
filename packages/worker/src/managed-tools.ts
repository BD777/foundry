/**
 * Programs Foundry installs on this device for skills, only when the person
 * asks: a bundle's CLI downloaded from the repository's GitHub release for
 * this platform, an npm package (from registry.npmjs.org, the https registry
 * Foundry names, or this device's own npm settings), or a Python package
 * through the device's own uv. GitHub downloads are https only,
 * size-bounded and checked against the release's checksums when it
 * publishes them; only the named binary is taken out of an archive. npm
 * packages install without running their install scripts. A tool's setup
 * step (e.g. downloading the browser it drives) runs only on its own click.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { foundryToolsRoot } from "./state-root.js";
import { unpackZip } from "./skill-zip.js";

const run = promisify(execFile);

export interface ToolAsset {
  os: string;
  arch: string;
  name: string;
  url: string;
}

export interface ToolSetup {
  /** A command the package installs; empty is the tool itself. */
  command?: string;
  args: string[];
  description?: string;
}

export interface ToolSpec {
  name: string;
  version: string;
  assets?: ToolAsset[];
  checksumsUrl?: string;
  /** "" is a GitHub release download; "npm" and "uv" install `package`. */
  source?: "npm" | "uv";
  package?: string;
  /**
   * Where an npm tool installs from: absent is registry.npmjs.org, an
   * https URL that registry, "device" this device's own npm settings.
   */
  registry?: string;
  setup?: ToolSetup;
}

export interface InstallOptions {
  /** Extra origins allowed besides GitHub's (tests serve releases locally). */
  allowedOrigins?: string[];
  /** The npm registry; tests serve one locally. */
  npmRegistry?: string;
}

const toolName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const versionName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const githubHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const npmPackageName = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const pypiPackageName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const setupArgument = /^[A-Za-z0-9-][A-Za-z0-9._=:@/,+-]{0,99}$/;
const maxDownloadBytes = 300 * 1024 * 1024;
const maxChecksumsBytes = 1024 * 1024;

/** The folder of current tool versions that sessions find first on PATH. */
export function managedToolsBin(): string {
  return resolve(foundryToolsRoot(), "bin");
}

/** PATH with Foundry's tools first. */
export function withManagedTools(path: string | undefined): string {
  const bin = managedToolsBin();
  return [
    bin,
    ...(path ?? "").split(":").filter((part) => part && part !== bin),
  ].join(":");
}

/** The versions Foundry installed here, by tool name. */
export function managedToolVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(managedToolsBin());
  } catch {
    return versions;
  }
  for (const name of names) {
    try {
      const target = readlinkSync(join(managedToolsBin(), name));
      const parts = target.split("/");
      const version = parts[parts.length - 2];
      if (version && existsSync(resolve(managedToolsBin(), target)))
        versions[name] = version;
    } catch {
      continue;
    }
  }
  return versions;
}

function platformAsset(spec: ToolSpec): ToolAsset {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch =
    process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  const asset = spec.assets?.find(
    (item) => item.os === os && item.arch === arch,
  );
  if (!asset)
    throw new Error(
      `${spec.name} ${spec.version} has no download for ${process.platform}/${process.arch}`,
    );
  return asset;
}

function allowed(url: URL, options: InstallOptions): boolean {
  if (options.allowedOrigins?.includes(url.origin)) return true;
  return url.protocol === "https:" && githubHosts.has(url.hostname);
}

/** Downloads at most `limit` bytes, following redirects to GitHub only. */
async function download(
  address: string,
  limit: number,
  options: InstallOptions,
): Promise<Buffer> {
  let url = new URL(address);
  for (let hop = 0; hop < 6; hop += 1) {
    if (!allowed(url, options))
      throw new Error(`refusing to download from ${url.origin}`);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect without a location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`download failed: ${response.status} ${url.pathname}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > limit) throw new Error("download is too large");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("download is too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("too many redirects");
}

async function expectedChecksum(
  spec: ToolSpec,
  asset: ToolAsset,
  options: InstallOptions,
): Promise<string | undefined> {
  if (!spec.checksumsUrl) return undefined;
  const text = (
    await download(spec.checksumsUrl, maxChecksumsBytes, options)
  ).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const [sum, file] = line.trim().split(/\s+\*?/);
    if (file && basename(file) === asset.name && /^[0-9a-f]{64}$/i.test(sum!))
      return sum!.toLowerCase();
  }
  throw new Error(`the release's checksums do not list ${asset.name}`);
}

function safeMember(entry: string): boolean {
  const normal = posix.normalize(entry);
  return (
    !entry.startsWith("/") &&
    !normal.startsWith("../") &&
    normal !== ".." &&
    !entry.includes("\0")
  );
}

/** The tool's binary out of an archive: the shallowest regular file named
 * after it. Nothing else is written. */
async function extractBinary(
  archive: Buffer,
  asset: ToolAsset,
  name: string,
): Promise<Buffer> {
  const lower = asset.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    const entry = unpackZip(archive, {
      maxBytes: maxDownloadBytes,
      maxFiles: 10000,
    })
      .filter((item) => basename(item.path) === name && safeMember(item.path))
      .sort((a, b) => a.path.length - b.path.length)[0];
    if (!entry) throw new Error(`${asset.name} has no ${name} inside`);
    return entry.data;
  }
  if (!lower.endsWith(".tar.gz") && !lower.endsWith(".tgz")) return archive;
  const work = mkdtempSync(join(tmpdir(), "foundry-tool-"));
  try {
    const file = join(work, "archive.tar.gz");
    writeFileSync(file, archive);
    const { stdout } = await run("tar", ["-tzf", file], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const member = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && basename(line) === name && safeMember(line))
      .sort((a, b) => a.length - b.length)[0];
    if (!member) throw new Error(`${asset.name} has no ${name} inside`);
    const out = join(work, "out");
    mkdirSync(out);
    await run("tar", ["-xzf", file, "-C", out, "--", member]);
    const extracted = resolve(out, member);
    if (!extracted.startsWith(`${out}/`))
      throw new Error("archive member leaves the folder");
    const info = lstatSync(extracted);
    if (!info.isFile()) throw new Error(`${name} in the archive is not a file`);
    if (info.size > maxDownloadBytes) throw new Error(`${name} is too large`);
    return readFileSync(extracted);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Installs a tool version for this device's platform and makes it the
 * current one. Returns the installed version and the binary's SHA-256.
 */
export async function installTool(
  spec: ToolSpec,
  options: InstallOptions = {},
): Promise<{ name: string; version: string; sha256: string }> {
  if (!toolName.test(spec.name) || !versionName.test(spec.version))
    throw new Error("invalid tool name or version");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`installing tools is not supported on ${process.platform}`);
  if (spec.source === "npm") return installNpmTool(spec, options);
  if (spec.source === "uv") return installUvTool(spec);
  if (spec.source) throw new Error(`unknown tool source ${spec.source}`);
  const asset = platformAsset(spec);
  const archive = await download(asset.url, maxDownloadBytes, options);
  const expected = await expectedChecksum(spec, asset, options);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (expected && expected !== actual)
    throw new Error(`${asset.name} does not match the release's checksum`);
  const binary = await extractBinary(archive, asset, spec.name);
  const root = foundryToolsRoot();
  const folder = resolve(root, spec.name, spec.version);
  mkdirSync(folder, { recursive: true });
  const target = join(folder, spec.name);
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, binary, { mode: 0o755 });
  chmodSync(staging, 0o755);
  renameSync(staging, target);
  makeCurrent(spec);
  return {
    name: spec.name,
    version: spec.version,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
}

/** Points bin/<name> at the version's entry, `<name>/<version>/<name>`. */
function makeCurrent(spec: ToolSpec): void {
  const bin = managedToolsBin();
  mkdirSync(bin, { recursive: true });
  const link = join(bin, spec.name);
  const linkStaging = `${link}.${process.pid}.tmp`;
  rmSync(linkStaging, { force: true });
  symlinkSync(`../${spec.name}/${spec.version}/${spec.name}`, linkStaging);
  renameSync(linkStaging, link);
}

/** Replaces `<folder>/<name>` with a symlink to target. */
function linkEntry(folder: string, name: string, target: string): void {
  const entry = join(folder, name);
  const staging = `${entry}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, entry);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A command on PATH (or next to this worker's node), if any. */
export function findCommand(
  name: string,
  extra: string[] = [],
): string | undefined {
  const dirs = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(":"),
    ...extra,
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** PATH for package managers and setup steps: this worker's node first,
 * then Foundry's tools. */
export function toolEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${withManagedTools(process.env.PATH)}`,
  };
}

function commandFailure(action: string, error: unknown): Error {
  const failed = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  const detail = `${failed.stderr ?? ""}\n${failed.stdout ?? ""}`.trim();
  return new Error(
    `${action} failed: ${tail(detail || failed.message || String(error), 2000)}`,
  );
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/**
 * Installs an npm package version into `<name>/<version>/npm` without its
 * install scripts and makes its command current. A command that runs on
 * node gets a small launcher, so it works where node is not on PATH.
 */
async function installNpmTool(
  spec: ToolSpec,
  options: InstallOptions,
): Promise<{ name: string; version: string; sha256: string }> {
  const pkg = spec.package ?? spec.name;
  if (!npmPackageName.test(pkg)) throw new Error("invalid npm package name");
  const npm = findCommand("npm");
  if (!npm)
    throw new Error(
      `${spec.name} installs with npm, which is not on this device`,
    );
  const folder = resolve(foundryToolsRoot(), spec.name, spec.version);
  const prefix = join(folder, "npm");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  try {
    await run(
      npm,
      [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--no-package-lock",
        ...(spec.registry
          ? npmRegistryArgs(pkg, spec.registry)
          : [
              "--registry",
              options.npmRegistry ?? "https://registry.npmjs.org/",
            ]),
        `${pkg}@${spec.version}`,
      ],
      {
        env: toolEnvironment(),
        timeout: 9 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    rmSync(prefix, { recursive: true, force: true });
    throw commandFailure(`npm install ${pkg}@${spec.version}`, error);
  }
  const command = join(prefix, "node_modules", ".bin", spec.name);
  if (!existsSync(command)) {
    rmSync(prefix, { recursive: true, force: true });
    throw new Error(`${pkg}@${spec.version} has no ${spec.name} command`);
  }
  const script = realpathSync(command);
  const firstLine = readFileSync(script, "utf8").split("\n", 1)[0] ?? "";
  if (/^#!.*\bnode\b/.test(firstLine)) {
    const launcher = join(folder, spec.name);
    const staging = `${launcher}.${process.pid}.tmp`;
    writeFileSync(
      staging,
      [
        "#!/bin/sh",
        `node=$(command -v node || echo ${shellQuote(process.execPath)})`,
        `exec "$node" ${shellQuote(script)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(staging, 0o755);
    renameSync(staging, launcher);
  } else {
    linkEntry(folder, spec.name, `npm/node_modules/.bin/${spec.name}`);
  }
  makeCurrent(spec);
  return {
    name: spec.name,
    version: spec.version,
    sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
  };
}

/**
 * npm's arguments for where a package comes from: none for "device" (this
 * device's npmrc and scoped registries decide), else the registry, which
 * also wins over a scoped registry the device sets for the package's scope.
 */
export function npmRegistryArgs(pkg: string, registry: string): string[] {
  if (registry === "device") return [];
  const url = new URL(registry);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("an npm registry must be an https address");
  const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : "";
  return [
    "--registry",
    registry,
    ...(scope ? [`--${scope}:registry=${registry}`] : []),
  ];
}

/** uv, which Foundry never installs; the person installs it. */
function findUv(): string | undefined {
  return findCommand("uv", [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
}

/**
 * Installs a Python package version with uv into its own
 * `<name>/<version>`, so versions stay side by side, and makes its command
 * current.
 */
async function installUvTool(
  spec: ToolSpec,
): Promise<{ name: string; version: string; sha256: string }> {
  const pkg = spec.package ?? spec.name;
  if (!pypiPackageName.test(pkg))
    throw new Error("invalid Python package name");
  const uv = findUv();
  if (!uv)
    throw new Error(
      `${spec.name} needs uv, which is not on this device; install uv (docs.astral.sh/uv) and try again`,
    );
  const folder = resolve(foundryToolsRoot(), spec.name, spec.version);
  mkdirSync(folder, { recursive: true });
  try {
    await run(uv, ["tool", "install", "--force", `${pkg}==${spec.version}`], {
      env: {
        ...toolEnvironment(),
        UV_TOOL_DIR: join(folder, "uv"),
        UV_TOOL_BIN_DIR: join(folder, "bin"),
      },
      timeout: 9 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw commandFailure(`uv tool install ${pkg}==${spec.version}`, error);
  }
  if (!existsSync(join(folder, "bin", spec.name)))
    throw new Error(`${pkg} ${spec.version} has no ${spec.name} command`);
  linkEntry(folder, spec.name, `bin/${spec.name}`);
  makeCurrent(spec);
  return {
    name: spec.name,
    version: spec.version,
    sha256: createHash("sha256")
      .update(readFileSync(realpathSync(join(folder, "bin", spec.name))))
      .digest("hex"),
  };
}

/**
 * Runs an installed tool's setup step, e.g. `agent-browser install`. It
 * runs only when the person asks; returns the end of its output.
 */
export async function runToolSetup(
  spec: ToolSpec,
): Promise<{ name: string; version: string; output: string }> {
  const setup = spec.setup;
  if (!setup) throw new Error(`${spec.name} has no setup step`);
  if (!toolName.test(spec.name) || !versionName.test(spec.version))
    throw new Error("invalid tool name or version");
  const commandName = setup.command || spec.name;
  if (
    !toolName.test(commandName) ||
    !Array.isArray(setup.args) ||
    !setup.args.every(
      (arg) => typeof arg === "string" && setupArgument.test(arg),
    )
  )
    throw new Error("invalid setup step");
  const folder = resolve(foundryToolsRoot(), spec.name, spec.version);
  const command =
    spec.source === "npm"
      ? join(folder, "npm", "node_modules", ".bin", commandName)
      : spec.source === "uv"
        ? join(folder, "bin", commandName)
        : join(folder, commandName);
  if (!existsSync(command))
    throw new Error(
      `install ${spec.name} ${spec.version} before setting it up`,
    );
  try {
    const { stdout, stderr } = await run(command, setup.args, {
      env: toolEnvironment(),
      timeout: 19 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      name: spec.name,
      version: spec.version,
      output: tail(`${stdout}\n${stderr}`, 4000),
    };
  } catch (error) {
    throw commandFailure(`${commandName} ${setup.args.join(" ")}`, error);
  }
}
