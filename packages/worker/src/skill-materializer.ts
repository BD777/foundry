/**
 * Materializes a session's resolved skill selection into one content-addressed
 * runtime tree the CLIs can load:
 *
 *   <state>/skill-sets/<setHash>/
 *     .claude-plugin/plugin.json   (Claude Code local plugin)
 *     skills/<name>/SKILL.md ...   (every selected revision, verified)
 *     skill-indexes/<id>.md        (one per large bundle, see skillCatalog)
 *
 * Packages are fetched from the server once per revision, checksum verified,
 * retained as checksum-verified archives and unpacked with the zip safety
 * rules in skill-zip. Every reuse verifies the full generated tree against
 * those archives, including scripts, indexes and plugin metadata. Sets get copies,
 * not links: a sandboxed agent may read the skill sets only. Nothing here
 * touches the user's own skill directories.
 */

import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  materializeSkillSnapshot,
  type SnapshotFile,
} from "./skill-snapshots.js";
import { writeFileAtomic } from "./storage.js";
import type {
  SessionSkillBundle,
  SessionSkillRef,
} from "@bd777/foundry-protocol";
import { daemonRequestHeaders } from "./server-http.js";
import {
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-scanner.js";
import { foundryStatePath } from "./state-root.js";
import { unpackZip } from "./skill-zip.js";

export interface ManagedSkill {
  name: string;
  /** Contains SKILL.md. */
  dir: string;
  description?: string;
  bundle?: SessionSkillBundle;
}

/**
 * Skills a session is told about as one catalog entry: a large bundle's, or
 * the ones past the catalog's size budget. Its file lists each skill's name,
 * one line of description and SKILL.md path.
 */
export interface SkillIndex {
  /** The bundle it stands for; absent for the catalog's overflow. */
  bundleId?: string;
  name: string;
  description?: string;
  version?: string;
  file: string;
  skills: string[];
}

export interface ManagedSkillRuntime {
  pluginDir: string;
  snapshotDigest?: string;
  manifestFile?: string;
  /** Selected skills, every one usable, listed or indexed. */
  skills: ManagedSkill[];
  /** Skills told about through an index file instead of one by one;
   * absent lists every skill. */
  indexes?: SkillIndex[];
  /** Native runtime inventory, populated before Codex execution. */
  hostSkillPaths?: string[];
  /**
   * The session's agent's own skills, which isolation keeps: named for
   * Claude Code, with their SKILL.md for Codex.
   */
  officialSkills?: { name: string; description?: string; path?: string }[];
}

function skillDescription(text: string): string {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  try {
    const data = header ? parseYaml(header[1]!) : {};
    return typeof data?.description === "string" ? data.description : "";
  } catch {
    return "";
  }
}

function setHash(refs: SessionSkillRef[]): string {
  const hash = createHash("sha256").update("skill-snapshot-v2\n");
  for (const ref of [...refs].sort(
    (a, b) => a.skillId.localeCompare(b.skillId) || a.revision - b.revision,
  )) {
    hash.update(
      JSON.stringify([
        ref.skillId,
        ref.revision,
        ref.checksum,
        ref.name,
        ref.bundle,
      ]) + "\n",
    );
  }
  return hash.digest("hex");
}

async function fetchSkillPackage(
  serverURL: string,
  ref: SessionSkillRef,
): Promise<Buffer> {
  const path = `/api/skills/catalog/${encodeURIComponent(ref.skillId)}/revisions/${ref.revision}/package`;
  const response = await fetch(`${serverURL}${path}`, {
    headers: daemonRequestHeaders(false),
  });
  if (!response.ok) {
    throw new Error(
      `skill package download failed (${response.status}) for ${ref.skillId}`,
    );
  }
  const checksumHeader = response.headers.get("X-Foundry-Skill-Checksum") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (checksumHeader && checksumHeader !== ref.checksum) {
    throw new Error(`skill checksum disagreement for ${ref.skillId}`);
  }
  if (actual !== ref.checksum) {
    throw new Error(`skill package checksum mismatch for ${ref.skillId}`);
  }
  if (buffer.length !== ref.byteSize) {
    throw new Error(`skill package size mismatch for ${ref.skillId}`);
  }
  return buffer;
}

const archiveReads = new Map<string, Promise<SnapshotFile[]>>();

async function verifiedSkillEntries(
  serverURL: string,
  ref: SessionSkillRef,
): Promise<SnapshotFile[]> {
  if (!/^[0-9a-f]{64}$/.test(ref.checksum))
    throw new Error(`invalid skill checksum for ${ref.skillId}`);
  const pending = archiveReads.get(ref.checksum);
  if (pending) return pending;
  const read = (async () => {
    const archive = foundryStatePath("skill-archives", `${ref.checksum}.zip`);
    let zip: Buffer | undefined;
    try {
      const cached = readFileSync(archive);
      if (
        cached.length === ref.byteSize &&
        createHash("sha256").update(cached).digest("hex") === ref.checksum
      )
        zip = cached;
    } catch {
      /* Legacy caches did not retain their verified archive. */
    }
    if (!zip) {
      zip = await fetchSkillPackage(serverURL, ref);
      writeFileAtomic(archive, zip);
    }
    const entries = unpackZip(zip, {
      allowLegacyCrc: true,
      maxBytes: SKILL_PACKAGE_MAX_BYTES,
      maxFiles: SKILL_PACKAGE_MAX_FILES,
    });
    if (!entries.some((entry) => entry.path === "SKILL.md"))
      throw new Error(
        `promoted skill ${ref.skillId} is missing a root SKILL.md`,
      );
    return entries;
  })();
  archiveReads.set(ref.checksum, read);
  try {
    return await read;
  } finally {
    if (archiveReads.get(ref.checksum) === read)
      archiveReads.delete(ref.checksum);
  }
}

/** Revisions fetched at once when a set needs several. */
const fetchConcurrency = 8;

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

/** A bundle with at least this many skills is one catalog entry. */
export const largeBundleSkills = 20;
/** Bytes of one-by-one catalog entries; skills past it go to an index. */
export const skillCatalogBudget = 24 * 1024;

/** A catalog entry for one skill, as the session is told it. */
export function skillCatalogEntry(skill: ManagedSkill): string {
  return JSON.stringify({
    name: skill.name,
    description: skill.description ?? "",
    file: join(skill.dir, "SKILL.md"),
  });
}

function oneLine(text: string | undefined, max = 200): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // Written below.
  }
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, content);
  renameSync(staging, path);
}

/**
 * Decides how the session is told about its skills and writes the index
 * files: a bundle of largeBundleSkills or more is one entry pointing at its
 * index; the other skills are listed one by one up to skillCatalogBudget,
 * and any past it share one more index. The text the session is told thus
 * stays bounded however many skills a workspace selects.
 */
export function skillCatalog(
  runtime: ManagedSkillRuntime,
  emitIndex: (path: string, contents: string) => void = (path, contents) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeIfChanged(path, contents);
  },
): ManagedSkillRuntime {
  const byBundle = new Map<string, ManagedSkill[]>();
  for (const skill of runtime.skills)
    if (skill.bundle)
      byBundle.set(skill.bundle.id, [
        ...(byBundle.get(skill.bundle.id) ?? []),
        skill,
      ]);
  const groups: {
    id: string;
    meta: Omit<SkillIndex, "file" | "skills">;
    skills: ManagedSkill[];
  }[] = [];
  const indexed = new Set<ManagedSkill>();
  for (const [id, skills] of byBundle) {
    if (skills.length < largeBundleSkills) continue;
    const bundle = skills[0]!.bundle!;
    groups.push({
      id,
      meta: {
        bundleId: id,
        name: bundle.name || id,
        ...(bundle.description ? { description: bundle.description } : {}),
        ...(bundle.version ? { version: bundle.version } : {}),
      },
      skills,
    });
    for (const skill of skills) indexed.add(skill);
  }
  let used = 0;
  const overflow = runtime.skills.filter((skill) => {
    if (indexed.has(skill)) return false;
    used += Buffer.byteLength(skillCatalogEntry(skill)) + 1;
    return used > skillCatalogBudget;
  });
  if (overflow.length)
    groups.push({
      id: "more-workspace-skills",
      meta: {
        name: "more workspace skills",
        description:
          "Workspace skills beyond what the catalog lists one by one.",
      },
      skills: overflow,
    });
  if (!groups.length) return { ...runtime, indexes: [] };
  const folder = join(runtime.pluginDir, "skill-indexes");
  const indexes = groups.map(({ id, meta, skills }) => {
    const file = join(folder, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.md`);
    emitIndex(
      file,
      [
        `# ${meta.name}${meta.version ? ` ${meta.version}` : ""}`,
        "",
        ...(meta.description ? [oneLine(meta.description, 1000), ""] : []),
        `${skills.length} skills. Open a skill's SKILL.md before using it.`,
        "",
        ...skills.map(
          (skill) =>
            `- ${skill.name}: ${oneLine(skill.description) || "(no description)"} (${join(skill.dir, "SKILL.md")})`,
        ),
        "",
      ].join("\n"),
    );
    return { ...meta, file, skills: skills.map((skill) => skill.name) };
  });
  return { ...runtime, indexes };
}

/**
 * Ensure the selected revisions are present on disk and return the runtime
 * tree. An empty selection returns a ready but empty tree (default-deny).
 */
export async function materializeSessionSkills(
  refs: SessionSkillRef[] | undefined,
  serverURL: string,
  workspaceCwd: string,
): Promise<ManagedSkillRuntime> {
  const ordered = [...(refs ?? [])].sort(
    (a, b) => a.skillId.localeCompare(b.skillId) || a.revision - b.revision,
  );

  const seenNames = new Set<string>();
  for (const ref of ordered) {
    // Promoted skill names were validated for unique selection server-side.
    const name = ref.name;
    if (
      name === "." ||
      name === ".." ||
      /[\/\\\0]/.test(name) ||
      /^[a-zA-Z]:/.test(name)
    ) {
      throw new Error(`unsafe skill invocation name: ${name}`);
    }
    if (!name || seenNames.has(name.toLowerCase())) {
      throw new Error(
        `duplicate or empty skill name in workspace selection: ${name}`,
      );
    }
    seenNames.add(name.toLowerCase());
  }

  const packages = await mapConcurrent(ordered, fetchConcurrency, (ref) =>
    verifiedSkillEntries(serverURL, ref),
  );
  return materializeSkillSnapshot(setHash(ordered), (dir) => {
    const files: SnapshotFile[] = [
      {
        path: ".claude-plugin/plugin.json",
        data: Buffer.from(
          JSON.stringify(
            { name: "foundry-workspace", version: "0.1.0" },
            null,
            2,
          ),
        ),
      },
    ];
    const skills = ordered.map((ref, index): ManagedSkill => {
      const entries = packages[index]!;
      for (const entry of entries)
        files.push({
          path: `skills/${ref.name}/${entry.path}`,
          data: entry.data,
        });
      return {
        name: ref.name,
        dir: join(dir, "skills", ref.name),
        description: skillDescription(
          entries.find((e) => e.path === "SKILL.md")!.data.toString("utf8"),
        ),
        ...(ref.bundle ? { bundle: ref.bundle } : {}),
      };
    });
    const value = skillCatalog({ pluginDir: dir, skills }, (file, contents) =>
      files.push({
        path: relative(dir, file).split("\\").join("/"),
        data: Buffer.from(contents),
      }),
    );
    return { files, value };
  });
}
