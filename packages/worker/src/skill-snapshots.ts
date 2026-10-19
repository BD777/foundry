import {
  markPrivateInputOwner,
  privateInputCanBeRemoved,
} from "./private-input-owners.js";
/** Verified immutable generations. Repair never overwrites an active path. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { foundryStatePath } from "./state-root.js";
import { writeFileAtomic } from "./storage.js";

export interface SnapshotFile {
  path: string;
  data: Buffer;
}
const manifestName = ".foundry-input-snapshot.json";
const pending = new Map<string, Promise<unknown>>();
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function manifest(files: SnapshotFile[]) {
  const paths = new Set<string>();
  const entries = files
    .map((file) => {
      if (
        !file.path ||
        file.path === manifestName ||
        file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path.split("/").some((p) => !p || p === "." || p === "..") ||
        /^[A-Za-z]:/.test(file.path) ||
        paths.has(file.path)
      )
        throw new Error("Unsafe or duplicate skill snapshot path.");
      paths.add(file.path);
      return {
        path: file.path,
        bytes: file.data.length,
        sha256: sha(file.data),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return `${JSON.stringify({ version: 1, files: entries })}\n`;
}

function holdsFiles(root: string, files: SnapshotFile[]): boolean {
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      return false;
    const expected = new Map(files.map((f) => [f.path, f.data]));
    const directories = new Set<string>();
    for (const path of expected.keys()) {
      let parent = dirname(path);
      while (parent !== ".") {
        directories.add(parent);
        parent = dirname(parent);
      }
    }
    const seen = new Set<string>();
    const walk = (folder: string): boolean => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name),
          key = relative(root, path).split("\\").join("/");
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (!directories.has(key) || !walk(path)) return false;
        } else {
          const bytes = expected.get(key);
          if (!entry.isFile() || !bytes || !readFileSync(path).equals(bytes))
            return false;
          seen.add(key);
        }
      }
      return true;
    };
    return walk(root) && seen.size === expected.size;
  } catch {
    return false;
  }
}

export async function materializeSkillSnapshot<T extends object>(
  key: string,
  describe: (directory: string) => { files: SnapshotFile[]; value: T },
  storageRoot = foundryStatePath("skill-sets"),
): Promise<T & { snapshotDigest: string; manifestFile: string }> {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid skill snapshot identity.");
  const pendingKey = `${storageRoot}\0${key}`;
  const current = pending.get(pendingKey);
  if (current)
    return current as Promise<
      T & { snapshotDigest: string; manifestFile: string }
    >;
  const job = Promise.resolve().then(() => build(key, describe, storageRoot));
  pending.set(pendingKey, job);
  try {
    return await job;
  } finally {
    if (pending.get(pendingKey) === job) pending.delete(pendingKey);
  }
}

function build<T extends object>(
  key: string,
  describe: (directory: string) => { files: SnapshotFile[]; value: T },
  root: string,
): T & { snapshotDigest: string; manifestFile: string } {
  const heads = join(root, ".heads");
  mkdirSync(heads, { recursive: true, mode: 0o700 });
  if (lstatSync(heads).isSymbolicLink())
    throw new Error("Skill snapshot index is not a directory.");
  const head = join(heads, `${key}.json`);
  let name = key;
  try {
    const saved = JSON.parse(readFileSync(head, "utf8")).directory;
    if (
      typeof saved === "string" &&
      new RegExp(`^${key}(?:\\.snapshot-[a-f0-9-]+)?$`).test(saved)
    )
      name = saved;
  } catch {
    /* First materialization. */
  }
  const describeAt = (directory: string) => {
    const prepared = describe(directory),
      body = manifest(prepared.files);
    return {
      ...prepared,
      files: [
        ...prepared.files,
        { path: manifestName, data: Buffer.from(body) },
      ],
      snapshotDigest: sha(body),
      manifestFile: join(directory, manifestName),
    };
  };
  let directory = join(root, name),
    prepared = describeAt(directory);
  if (holdsFiles(directory, prepared.files))
    return {
      ...prepared.value,
      snapshotDigest: prepared.snapshotDigest,
      manifestFile: prepared.manifestFile,
    };
  // Corrupt/old generations can still be held by another runtime. Leave them
  // in place and prepare a new exact path for this execution.
  if (existsSync(directory)) {
    name = `${key}.snapshot-${randomUUID()}`;
    directory = join(root, name);
    prepared = describeAt(directory);
  }
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    markPrivateInputOwner(staging, "skill-staging", `${staging}.owner.json`);
    for (const file of prepared.files) {
      const path = join(staging, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.data, { mode: 0o600 });
    }
    try {
      renameSync(staging, directory);
    } catch (error) {
      if (!holdsFiles(directory, prepared.files)) throw error;
      // Another builder published the same verified generation first.
    }
    writeFileAtomic(head, JSON.stringify({ version: 1, directory: name }));
    return {
      ...prepared.value,
      snapshotDigest: prepared.snapshotDigest,
      manifestFile: prepared.manifestFile,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(`${staging}.owner.json`, { force: true });
  }
}

/** Reopen an exact previously prepared generation; a changed manifest is rejected. */
export function readVerifiedSkillSnapshot(
  root: string,
  expectedDigest: string,
): SnapshotFile[] {
  try {
    return readSnapshot(root, expectedDigest);
  } catch (original) {
    const key = /^([a-f0-9]{64})(?:\.snapshot-[a-f0-9-]+)?$/.exec(
      basename(root),
    )?.[1];
    if (!key) throw original;
    try {
      const head = JSON.parse(
        readFileSync(join(dirname(root), ".heads", `${key}.json`), "utf8"),
      ).directory;
      if (
        typeof head !== "string" ||
        !new RegExp(`^${key}(?:\\.snapshot-[a-f0-9-]+)?$`).test(head) ||
        head === basename(root)
      )
        throw original;
      return readSnapshot(join(dirname(root), head), expectedDigest);
    } catch {
      throw original;
    }
  }
}
function readSnapshot(root: string, expectedDigest: string): SnapshotFile[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("Unsafe skill snapshot root.");
  const regular = (path: string) => {
    const parts = path.split("/");
    if (
      !path ||
      path.includes("\\") ||
      path.includes("\0") ||
      /^[A-Za-z]:/.test(path) ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe skill snapshot path.");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      )
        throw new Error("Unsafe skill snapshot entry.");
    }
    return current;
  };
  const body = readFileSync(regular(manifestName), "utf8");
  if (sha(body) !== expectedDigest)
    throw new Error("Skill snapshot manifest changed.");
  const entries = JSON.parse(body).files as {
    path: string;
    bytes: number;
    sha256: string;
  }[];
  const files = entries.map((entry) => ({
    path: entry.path,
    data: readFileSync(regular(entry.path)),
  }));
  if (
    manifest(files) !== body ||
    !holdsFiles(root, [
      ...files,
      { path: manifestName, data: Buffer.from(body) },
    ])
  )
    throw new Error("Skill snapshot contents changed.");
  return files;
}

/** Keep every historical content head; collect only superseded repair generations at idle. */
export function collectSkillSnapshotGarbage(
  options: { idle: boolean; now?: number; minAgeMs?: number },
  root = foundryStatePath("skill-sets"),
): number {
  if (!options.idle) return 0;
  let removed = 0;
  const now = options.now ?? Date.now(),
    minAge = options.minAgeMs ?? 24 * 60 * 60 * 1000;
  try {
    if (lstatSync(root).isSymbolicLink()) return 0;
    const heads = join(root, ".heads");
    if (lstatSync(heads).isSymbolicLink()) return 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (removed >= 50) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (entry.name.startsWith(".staging-")) {
        if (
          privateInputCanBeRemoved(path, "skill-staging", {
            marker: `${path}.owner.json`,
            now,
            minAgeMs: minAge,
            allowUnsupervised: true,
          })
        ) {
          rmSync(path, { recursive: true, force: true });
          rmSync(`${path}.owner.json`, { force: true });
          removed++;
        }
        continue;
      }
      const key = /^([a-f0-9]{64})(?:\.snapshot-[a-f0-9-]+)?$/.exec(
        entry.name,
      )?.[1];
      if (!key || now - lstatSync(path).mtimeMs < minAge) continue;
      try {
        const head = JSON.parse(
          readFileSync(join(heads, `${key}.json`), "utf8"),
        ).directory;
        if (
          typeof head !== "string" ||
          !new RegExp(`^${key}(?:\\.snapshot-[a-f0-9-]+)?$`).test(head) ||
          head === entry.name
        )
          continue;
        // Only byte-equivalent replacements can retire a historical path.
        if (!lstatSync(join(path, manifestName)).isFile()) continue;
        const expected = sha(readFileSync(join(path, manifestName), "utf8"));
        readSnapshot(join(root, head), expected);
        rmSync(path, { recursive: true, force: true });
        removed++;
      } catch {
        /* Unknown head: never guess that a generation is obsolete. */
      }
    }
  } catch {
    /* Missing/unreadable roots confer no cleanup authority. */
  }
  return removed;
}
