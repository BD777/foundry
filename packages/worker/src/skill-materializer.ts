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
 * unpacked with the zip safety rules in skill-zip and kept by checksum in
 * <state>/skill-revisions, so a new set (one skill updated) copies the
 * unchanged ones locally instead of downloading them again. Sets get copies,
 * not links: a sandboxed agent may read the skill sets only. Nothing here
 * touches the user's own skill directories.
 */

import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

function skillDescription(dir: string): string {
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  try {
    const data = header ? parseYaml(header[1]!) : {};
    return typeof data?.description === "string" ? data.description : "";
  } catch {
    return "";
  }
}

function setsRoot(): string {
  return foundryStatePath("skill-sets");
}

function setHash(refs: SessionSkillRef[]): string {
  const hash = createHash("sha256");
  for (const ref of [...refs].sort(
    (a, b) => a.skillId.localeCompare(b.skillId) || a.revision - b.revision,
  )) {
    hash.update(`${ref.skillId}:${ref.revision}:${ref.checksum}\n`);
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

function writeUnpacked(
  targetDir: string,
  entries: { path: string; data: Buffer }[],
  checksum: string,
): void {
  const staging = `${targetDir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of entries) {
    const full = join(staging, entry.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, entry.data);
  }
  writeFileSync(join(staging, checksumFileName), checksum);
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(staging, targetDir);
}

const checksumFileName = ".foundry-skill-checksum";

function holdsRevision(dir: string, checksum: string): boolean {
  try {
    return (
      existsSync(join(dir, "SKILL.md")) &&
      readFileSync(join(dir, checksumFileName), "utf8") === checksum
    );
  } catch {
    return false;
  }
}

/** The verified, unpacked revision, downloaded only if no set had it yet. */
async function unpackedRevision(
  serverURL: string,
  ref: SessionSkillRef,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(ref.checksum))
    throw new Error(`invalid skill checksum for ${ref.skillId}`);
  const dir = foundryStatePath("skill-revisions", ref.checksum);
  if (holdsRevision(dir, ref.checksum)) return dir;
  const zip = await fetchSkillPackage(serverURL, ref);
  const entries = unpackZip(zip, {
    // fetchSkillPackage has already verified the immutable revision SHA-256.
    allowLegacyCrc: true,
    maxBytes: SKILL_PACKAGE_MAX_BYTES,
    maxFiles: SKILL_PACKAGE_MAX_FILES,
  });
  if (!entries.some((entry) => entry.path === "SKILL.md")) {
    throw new Error(`promoted skill ${ref.skillId} is missing a root SKILL.md`);
  }
  mkdirSync(foundryStatePath("skill-revisions"), { recursive: true });
  writeUnpacked(dir, entries, ref.checksum);
  return dir;
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
  mkdirSync(folder, { recursive: true });
  const indexes = groups.map(({ id, meta, skills }) => {
    const file = join(folder, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.md`);
    writeIfChanged(
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
  const dir = join(setsRoot(), setHash(ordered));
  const pluginMarker = join(dir, ".claude-plugin", "plugin.json");
  const skillsRoot = join(dir, "skills");

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

  const skills = await mapConcurrent(
    ordered,
    fetchConcurrency,
    async (ref): Promise<ManagedSkill> => {
      const targetDir = join(skillsRoot, ref.name);
      if (!holdsRevision(targetDir, ref.checksum)) {
        const source = await unpackedRevision(serverURL, ref);
        const staging = `${targetDir}.staging-${process.pid}`;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(skillsRoot, { recursive: true });
        cpSync(source, staging, { recursive: true });
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(staging, targetDir);
      }
      return {
        name: ref.name,
        dir: targetDir,
        description: skillDescription(targetDir),
        ...(ref.bundle ? { bundle: ref.bundle } : {}),
      };
    },
  );

  if (!existsSync(pluginMarker)) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      pluginMarker,
      JSON.stringify({ name: "foundry-workspace", version: "0.1.0" }, null, 2),
    );
  }

  return skillCatalog({ pluginDir: dir, skills });
}
