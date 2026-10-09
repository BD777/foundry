/**
 * Reads skill repositories for the server when it cannot reach them (an
 * intranet git host or npm registry). git and npm run with this device's
 * own settings and credentials (its git config, ssh keys, credential
 * helpers and npmrc); none of them leave the device. Nothing prompts:
 * a remote that needs a password Foundry does not have fails with git's or
 * npm's own words.
 *
 * Git repositories are fetched one commit deep into a cache under the
 * worker's state root; the skill folders of the version (each folder with a
 * SKILL.md, as the server looks for them) and the repository's license and
 * manifest files are zipped and uploaded. npm packages are downloaded with
 * `npm pack` (which checks the registry's integrity hash and runs no
 * scripts) and uploaded as they are. The server unpacks and checks both.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { foundryStatePath } from "./state-root.js";
import {
  findCommand,
  npmRegistryArgs,
  toolEnvironment,
} from "./managed-tools.js";
import { packZip, type ZipEntry } from "./skill-zip.js";

export interface RepositoryRefsRequest {
  remote: string;
  /** Every tag (git). */
  tags?: boolean;
  /** HEAD, refs/heads/<name>, refs/tags/<name>[^{}] (git). */
  patterns?: string[];
  /** npm registry (https); absent uses this device's npm settings. */
  registry?: string;
}

export interface RepositoryRefs {
  /** `git ls-remote` output. */
  refs?: string;
  distTags?: Record<string, string>;
  versions?: string[];
}

export interface FetchRepositoryRequest {
  remote: string;
  ref?: string;
  subpath?: string;
  registry?: string;
  uploadPath: string;
}

const npmPrefix = "npm:";
const npmPackageName = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const httpsRemote = /^https:\/\/[^\s@/]+\/\S+$/;
const sshRemote =
  /^ssh:\/\/([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/\S+$/;
const scpRemote =
  /^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~][A-Za-z0-9._~/-]*$/;
const refName = /^[A-Za-z0-9._/-]{1,200}$/;
const refPattern =
  /^(HEAD|refs\/(heads|tags)\/[A-Za-z0-9._/-]{1,200}(\^\{\})?)$/;
const npmRef = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const licenseFiles = ["LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"];
/** Folders deeper than this below the subpath are not searched, as on the server. */
const maxDepth = 4;
const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 200 * 1024 * 1024;
const maxFiles = 50_000;
const commandTimeoutMs = 5 * 60 * 1000;

function checkRemote(remote: string): void {
  if (remote.startsWith(npmPrefix)) {
    if (!npmPackageName.test(remote.slice(npmPrefix.length)))
      throw new Error("invalid npm package name");
    return;
  }
  if (
    !(
      httpsRemote.test(remote) ||
      sshRemote.test(remote) ||
      scpRemote.test(remote)
    ) ||
    remote.includes("..")
  )
    throw new Error("only https and ssh git remotes are read");
}

function checkRef(ref: string | undefined): string {
  const value = ref ?? "";
  if (
    value &&
    (!refName.test(value) || value.startsWith("-") || value.includes(".."))
  )
    throw new Error(`invalid branch or tag ${value}`);
  return value;
}

function checkSubpath(subpath: string | undefined): string {
  const clean = posix.normalize((subpath ?? "").replace(/^\/+|\/+$/g, ""));
  if (clean === "." || clean === "") return "";
  if (clean === ".." || clean.startsWith("../") || clean.includes("\0"))
    throw new Error("the folder must stay inside the repository");
  return clean;
}

/**
 * Runs a command in its own session, so ssh or a credential helper finds no
 * terminal to ask on, and nothing waits for input.
 */
function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => stop(new Error(`${command} ${args[0]} took too long`)),
      commandTimeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes)
        stop(new Error(`${command} ${args[0]} answered too much`));
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(err).length < 64 * 1024) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return rejectPromise(failure);
      if (code === 0)
        return resolvePromise(Buffer.concat(out).toString("utf8"));
      const message = Buffer.concat(err).toString("utf8").trim();
      rejectPromise(
        new Error(
          (message.length > 1500 ? `…${message.slice(-1500)}` : message) ||
            `${command} ${args[0]} exited with ${code}`,
        ),
      );
    });
  });
}

function git(args: string[], cwd?: string): Promise<string> {
  return runCommand("git", args, { cwd });
}

function npmCommand(): string {
  const npm = findCommand("npm");
  if (!npm) throw new Error("npm is not on this device");
  return npm;
}

function npmPackage(remote: string): string {
  return remote.slice(npmPrefix.length);
}

function registryArgs(pkg: string, registry: string | undefined): string[] {
  return npmRegistryArgs(pkg, registry ? registry : "device");
}

/** Refs of a git remote or the versions of an npm package. */
export async function readRepositoryRefs(
  request: RepositoryRefsRequest,
): Promise<RepositoryRefs> {
  checkRemote(request.remote);
  if (request.remote.startsWith(npmPrefix)) {
    const pkg = npmPackage(request.remote);
    const work = mkdtempSync(join(tmpdir(), "foundry-npm-view-"));
    try {
      const out = await runCommand(
        npmCommand(),
        [
          "view",
          pkg,
          "dist-tags",
          "versions",
          "--json",
          ...registryArgs(pkg, request.registry),
        ],
        { cwd: work, env: toolEnvironment() },
      );
      const parsed = JSON.parse(out) as {
        "dist-tags"?: Record<string, string>;
        versions?: string[] | string;
      };
      const versions = parsed.versions;
      return {
        distTags: parsed["dist-tags"] ?? {},
        versions: Array.isArray(versions)
          ? versions
          : versions
            ? [versions]
            : [],
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const patterns = request.patterns ?? [];
  for (const pattern of patterns)
    if (!refPattern.test(pattern) || pattern.includes(".."))
      throw new Error(`invalid ref ${pattern}`);
  return {
    refs: await git([
      "ls-remote",
      ...(request.tags ? ["--tags"] : []),
      "--",
      request.remote,
      ...patterns,
    ]),
  };
}

/** The cache folder of one remote, and a queue so one fetch uses it at a time. */
const cacheQueues = new Map<string, Promise<unknown>>();

function cacheFolder(remote: string): string {
  const key = createHash("sha256").update(remote).digest("hex").slice(0, 24);
  return foundryStatePath("skill-repositories", key);
}

async function inCache<T>(
  remote: string,
  work: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = cacheFolder(remote);
  const previous = cacheQueues.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => work(dir));
  cacheQueues.set(dir, run);
  try {
    return await run;
  } finally {
    if (cacheQueues.get(dir) === run) cacheQueues.delete(dir);
  }
}

/**
 * Fetches ref (a branch, else a tag; the default branch when empty) one
 * commit deep and checks it out in the remote's cache folder.
 */
async function checkoutRef(
  dir: string,
  remote: string,
  ref: string,
): Promise<string> {
  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await git(["init", "--quiet", dir]);
  }
  const fetch = (refspec: string) =>
    git(
      [
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        "--force",
        "--",
        remote,
        refspec,
      ],
      dir,
    );
  if (!ref) await fetch("HEAD");
  else {
    try {
      await fetch(`refs/heads/${ref}`);
    } catch (branchError) {
      try {
        await fetch(`refs/tags/${ref}`);
      } catch {
        throw branchError;
      }
    }
  }
  await git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], dir);
  await git(["clean", "-ffdxq"], dir);
  return (await git(["rev-parse", "HEAD"], dir)).trim();
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function directory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folders under start holding a SKILL.md, not searching inside them. */
export function findSkillFolders(root: string, start: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth + 1) return;
    const full = rel ? join(root, rel) : root;
    if (regularFile(join(full, "SKILL.md"))) {
      found.push(rel);
      return;
    }
    let names: string[] = [];
    try {
      names = readdirSync(full);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === ".git") continue;
      const child = rel ? `${rel}/${name}` : name;
      if (directory(join(root, child))) walk(child, depth + 1);
    }
  };
  if (directory(start ? join(root, start) : root)) walk(start, 0);
  return found;
}

/** The skill folders' files and the repository's license and manifest files. */
export function collectSkillTree(root: string, subpath: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let total = 0;
  const add = (rel: string) => {
    const full = join(root, rel);
    const size = lstatSync(full).size;
    if (size > maxFileBytes)
      throw new Error(
        `${rel} is larger than ${maxFileBytes / 1024 / 1024} MiB`,
      );
    total += size;
    if (total > maxTotalBytes || entries.length >= maxFiles)
      throw new Error("the repository's skills are larger than the limit");
    entries.push({ path: rel, data: readFileSync(full) });
  };
  const addFolder = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name === ".git") continue;
      const child = rel ? `${rel}/${name}` : name;
      if (regularFile(join(root, child))) add(child);
      else if (directory(join(root, child))) addFolder(child);
    }
  };
  for (const folder of findSkillFolders(root, subpath)) {
    if (folder === "") addFolder("");
    else addFolder(folder);
  }
  const seen = new Set(entries.map((entry) => entry.path));
  const extra = [
    ...licenseFiles,
    ...(subpath
      ? [`${subpath}/manifest.yaml`, `${subpath}/manifest.json`]
      : ["manifest.yaml", "manifest.json"]),
  ];
  for (const rel of extra)
    if (!seen.has(rel) && regularFile(join(root, rel))) add(rel);
  return entries;
}

/**
 * Takes a version of a repository or package and uploads its files with
 * `upload`; returns the commit (git) or version (npm) they are from.
 */
export async function fetchSkillRepository(
  request: FetchRepositoryRequest,
  upload: (body: Buffer, contentType: string) => Promise<void>,
): Promise<{ commit: string }> {
  checkRemote(request.remote);
  if (request.remote.startsWith(npmPrefix)) {
    const pkg = npmPackage(request.remote);
    const ref = request.ref || "latest";
    if (!npmRef.test(ref)) throw new Error(`invalid npm version ${ref}`);
    const work = mkdtempSync(join(tmpdir(), "foundry-npm-pack-"));
    try {
      const out = await runCommand(
        npmCommand(),
        [
          "pack",
          `${pkg}@${ref}`,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          work,
          ...registryArgs(pkg, request.registry),
        ],
        { cwd: work, env: toolEnvironment() },
      );
      const packed = (JSON.parse(out) as { version?: string }[])[0];
      const file = readdirSync(work).find((name) => name.endsWith(".tgz"));
      if (!packed?.version || !file)
        throw new Error(`npm pack gave no package for ${pkg}@${ref}`);
      await upload(readFileSync(join(work, file)), "application/gzip");
      return { commit: packed.version };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const ref = checkRef(request.ref);
  const subpath = checkSubpath(request.subpath);
  return inCache(request.remote, async (dir) => {
    const commit = await checkoutRef(dir, request.remote, ref);
    await upload(packZip(collectSkillTree(dir, subpath)), "application/zip");
    return { commit };
  });
}
