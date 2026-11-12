import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isInside } from "../platform/paths.js";
import { foundryToolsRoot } from "../platform/state-root.js";
import {
  findCommand,
  linkManagedTool,
  managedToolInUse,
  managedToolsBin,
  toolEnvironment,
  toolVersionEntry,
} from "./managed-tools.js";

const run = promisify(execFile);
const maxArchiveBytes = 300 * 1024 * 1024;
const commandName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const commitName = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const githubRepository =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;

export interface RepositoryToolSpec {
  name: string;
  version: string;
  source: "repository";
  repository: string;
  path: string;
  bins: Record<string, string>;
}

/**
 * Install one folder of a GitHub repository at the exact commit the bundle
 * recorded. The archive is read with the Foundry-managed GitHub CLI login;
 * the Worker never falls back to this device's git credentials.
 */
export async function installRepositoryTool(
  spec: RepositoryToolSpec,
  options: {
    activate?: boolean;
    /**
     * The tool's folder as another device read it (packRepositoryTool): used
     * instead of reading the repository with this device's GitHub CLI.
     */
    archive?: Buffer;
  } = {},
): Promise<{ name: string; version: string; sha256: string }> {
  const clean = checkedSpec(spec);
  const work = mkdtempSync(join(tmpdir(), "foundry-repository-tool-"));
  const archive = join(work, "repository.tar.gz");
  try {
    let bytes: Buffer;
    if (options.archive) {
      bytes = options.archive;
      writeFileSync(archive, bytes);
    } else {
      const gh = ghCommand();
      if (!gh)
        throw new Error(
          "GitHub CLI is not installed on this device. Install GitHub CLI in Foundry first.",
        );
      const { owner, repo } = splitRepository(clean.repository);
      bytes = await fetchArchive(gh, owner, repo, clean.version, archive);
    }
    const folder = join(repositoryToolsRoot(), clean.name, clean.version);
    if (!existsSync(folder)) {
      const staging = join(
        dirname(folder),
        `.${clean.version}.${process.pid}.tmp`,
      );
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        const repository = join(staging, "repository");
        await extractPath(archive, clean.path, repository);
        for (const [name, path] of Object.entries(clean.bins))
          sourceEntry(repository, path);
        mkdirSync(dirname(folder), { recursive: true });
        renameSync(staging, folder);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    for (const [name, path] of Object.entries(clean.bins))
      writeEntry(folder, name, path);
    if (options.activate !== false) activateRepositoryTool(clean);
    return {
      name: clean.name,
      version: clean.version,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Reads one repository tool's folder at its exact commit with this device's
 * GitHub CLI and packs only that folder (under the archive's root folder, as
 * GitHub names it), for the server to hand to devices that cannot read the
 * repository themselves.
 */
export async function packRepositoryTool(
  spec: RepositoryToolSpec,
): Promise<{ archive: Buffer; sha256: string }> {
  const clean = checkedSpec(spec);
  const gh = ghCommand();
  if (!gh)
    throw new Error(
      "GitHub CLI is not installed on this device. Install GitHub CLI in Foundry first.",
    );
  const { owner, repo } = splitRepository(clean.repository);
  const work = mkdtempSync(join(tmpdir(), "foundry-repository-pack-"));
  try {
    const full = join(work, "repository.tar.gz");
    await fetchArchive(gh, owner, repo, clean.version, full);
    const root = await archiveRoot(full, clean.path);
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    await run(
      "tar",
      ["-xzf", full, "-C", unpacked, "--", `${root}/${clean.path}`],
      {
        env: archiveEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const tool = join(unpacked, root, clean.path);
    removeAppleDoubleEntries(tool);
    assertTreeInside(tool);
    const packed = join(work, "tool.tar.gz");
    const { stdout: version } = await run("tar", ["--version"], {
      maxBuffer: 16 * 1024,
    });
    const noMacMetadata = /\bbsdtar\b/i.test(version)
      ? ["--no-mac-metadata"]
      : [];
    await run("tar", [...noMacMetadata, "-czf", packed, "-C", unpacked, root], {
      env: archiveEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    });
    const archive = readFileSync(packed);
    return {
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Atomically makes every bin of an installed repository version current. */
export function activateRepositoryTool(spec: RepositoryToolSpec): {
  name: string;
  version: string;
} {
  const clean = checkedSpec(spec);
  const folder = resolve(dirname(toolVersionEntry(clean.name, clean.version)));
  if (!existsSync(folder))
    throw new Error(
      `${clean.name} ${clean.version} is not installed on this device`,
    );
  for (const name of Object.keys(clean.bins)) {
    if (!existsSync(join(folder, name)))
      throw new Error(`${clean.name} ${clean.version} has no ${name} entry`);
    linkManagedTool(name, `../${clean.name}/${clean.version}/${name}`);
  }
  return { name: clean.name, version: clean.version };
}

/** Removes a repository version and bin links that point into it. */
export function uninstallRepositoryTool(spec: RepositoryToolSpec): {
  name: string;
  version: string;
} {
  const clean = checkedSpec(spec);
  const folder = resolve(dirname(toolVersionEntry(clean.name, clean.version)));
  if (!existsSync(folder)) return { name: clean.name, version: clean.version };
  if (managedToolInUse(folder))
    throw new Error(
      `${clean.name} ${clean.version} is in use by a running session`,
    );
  for (const name of Object.keys(clean.bins)) {
    const link = join(managedToolsBin(), name);
    try {
      const target = resolve(managedToolsBin(), readlinkSync(link));
      if (isInside(folder, target)) rmSync(link, { force: true });
    } catch {
      continue;
    }
  }
  rmSync(folder, { recursive: true, force: true });
  return { name: clean.name, version: clean.version };
}

export function repositoryToolsRoot(): string {
  return foundryToolsRoot();
}

function checkedSpec(spec: RepositoryToolSpec): RepositoryToolSpec {
  if (
    !spec ||
    spec.source !== "repository" ||
    !commandName.test(spec.name) ||
    !commitName.test(spec.version)
  )
    throw new Error("invalid repository tool name, version or source");
  const repository = spec.repository.trim().replace(/\.git$/, "");
  if (!githubRepository.test(repository))
    throw new Error("a repository tool names a GitHub HTTPS repository");
  relativePath(spec.path, "tool path");
  if (!spec.bins || typeof spec.bins !== "object")
    throw new Error("a repository tool names its bins");
  const names = Object.keys(spec.bins);
  if (names.length === 0 || names.length > 32 || !names.includes(spec.name))
    throw new Error("the tool command must be one of its bins");
  for (const name of names) {
    if (!commandName.test(name))
      throw new Error("invalid repository tool bin name");
    relativePath(spec.bins[name]!, `bin ${name}`);
  }
  return { ...spec, repository, bins: { ...spec.bins } };
}

function relativePath(value: string, what: string): string {
  if (
    !value ||
    value.length > 300 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${what} must stay inside the repository`);
  return value;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const match = githubRepository.exec(repository);
  if (!match) throw new Error("invalid GitHub repository");
  return { owner: match[1]!, repo: match[2]! };
}

function ghCommand(): string | undefined {
  const managed = join(managedToolsBin(), "gh");
  return existsSync(managed) ? managed : findCommand("gh");
}

function fetchArchive(
  gh: string,
  owner: string,
  repo: string,
  commit: string,
  output: string,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      gh,
      [
        "api",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        `repos/${owner}/${repo}/tarball/${commit}`,
      ],
      {
        env: {
          ...toolEnvironment(),
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("GitHub repository download took too long");
      child.kill("SIGKILL");
    }, 5 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxArchiveBytes) {
        failure = new Error("GitHub repository download is too large");
        child.kill("SIGKILL");
      } else {
        chunks.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(githubFailure(`${owner}/${repo}`, stderr));
      const body = Buffer.concat(chunks);
      if (body.length === 0)
        return reject(
          new Error(
            `GitHub returned an empty repository archive for ${owner}/${repo}`,
          ),
        );
      try {
        writeFileSync(output, body);
      } catch (error) {
        return reject(error);
      }
      resolvePromise(body);
    });
  });
}

function githubFailure(repository: string, stderr: string): Error {
  const detail = stderr
    .replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-800);
  const text = detail.toLowerCase();
  if (
    /not logged in|authentication required|bad credentials|http 401|please run: gh auth login/.test(
      text,
    )
  )
    return new Error(
      `GitHub CLI is not signed in on this device. Sign in to the GitHub CLI connector, then retry reading ${repository}.`,
    );
  if (
    /http 403|http 404|forbidden|not found|resource not accessible|permission|denied/.test(
      text,
    )
  )
    return new Error(
      `GitHub CLI cannot read ${repository}. Give the GitHub CLI connector access to this repository.`,
    );
  return new Error(
    `GitHub CLI could not read ${repository}${detail ? `: ${detail}` : ""}`,
  );
}

async function archiveRoot(archive: string, path: string): Promise<string> {
  const { stdout } = await run("tar", ["-tzf", archive], {
    env: archiveEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
  const members = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const content = members.filter((member) => !archiveMetadata(member));
  const first = content[0];
  if (!first) throw new Error("GitHub returned an empty repository archive");
  const root = first.split("/")[0]!;
  const others = [
    ...new Set(
      content
        .map((member) => member.split("/")[0]!)
        .filter((top) => top !== root),
    ),
  ];
  if (!root || others.length > 0)
    throw new Error(
      `the repository archive has more than one root folder: ${[root, ...others].slice(0, 5).join(", ")}`,
    );
  const wanted = `${root}/${path}`;
  if (
    !content.some(
      (member) => member === wanted || member.startsWith(`${wanted}/`),
    )
  )
    throw new Error(`${path} is not a folder at this bundle version`);
  return root;
}

async function extractPath(
  archive: string,
  path: string,
  destination: string,
): Promise<void> {
  const root = await archiveRoot(archive, path);
  const wanted = `${root}/${path}`;
  mkdirSync(destination, { recursive: true });
  await run(
    "tar",
    [
      "-xzf",
      archive,
      "-C",
      destination,
      "--strip-components",
      String(root.split("/").length + path.split("/").length),
      "--",
      wanted,
    ],
    { env: archiveEnvironment(), maxBuffer: 16 * 1024 * 1024 },
  );
  removeAppleDoubleEntries(destination);
  assertTreeInside(destination);
}

function archiveEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, COPYFILE_DISABLE: "1" };
}

function archiveMetadata(member: string): boolean {
  const clean = member.replace(/^(?:\.\/)+/, "");
  const first = clean.split("/")[0] ?? "";
  return first === "pax_global_header" || first.startsWith("._");
}

function removeAppleDoubleEntries(folder: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.name.startsWith("._")) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (lstatSync(path).isDirectory()) removeAppleDoubleEntries(path);
  }
}

function assertTreeInside(folder: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      if (!isInside(realpathSync(folder), realpathSync(path)))
        throw new Error(`${entry.name} leaves the repository tool folder`);
      continue;
    }
    if (info.isDirectory()) assertTreeInside(path);
  }
}

function sourceEntry(folder: string, path: string): string {
  relativePath(path, "tool bin");
  const source = resolve(folder, path);
  const real = realpathSync(source);
  if (!isInside(realpathSync(folder), real))
    throw new Error(`${path} leaves the repository tool folder`);
  const info = lstatSync(real);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  return real;
}

function writeEntry(folder: string, name: string, path: string): void {
  const repository = join(folder, "repository");
  const source = sourceEntry(repository, path);
  const entry = join(folder, name);
  const staging = `${entry}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  if (isNodeEntry(source)) {
    writeFileSync(
      staging,
      [
        "#!/bin/sh",
        `node=$(command -v node || echo ${shellQuote(process.execPath)})`,
        `exec "$node" ${shellQuote(source)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(staging, 0o755);
  } else {
    writeFileSync(
      staging,
      [
        "#!/bin/sh",
        `PATH=${shellQuote(dirname(process.execPath))}:"$PATH" export PATH`,
        `exec ${shellQuote(source)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(staging, 0o755);
  }
  renameSync(staging, entry);
}

function isNodeEntry(source: string): boolean {
  return (
    source.endsWith(".mjs") ||
    source.endsWith(".js") ||
    /^#!.*\bnode\b/.test(readFileSync(source, "utf8").split("\n", 1)[0] ?? "")
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
