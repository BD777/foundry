/**
 * Device-local skill discovery and packaging. A skill is a directory
 * containing SKILL.md with YAML frontmatter; both ~/.claude/skills and
 * ~/.codex/skills use this layout.
 */

import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  DeviceSkill,
  SkillDependency,
  SkillFileInfo,
} from "@foundry/protocol";
import { packZip, assertSafeEntryPath } from "./skill-zip.js";
import {
  createSkillDependencyAnalyzer,
  type KnownSkill,
} from "./skill-dependencies.js";

import { readSkillInventory, SKILL_ARCHIVE_MAX_BYTES } from "./skill-files.js";
export {
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-files.js";

const SKILL_FILE_NAME = "SKILL.md";
const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9-_ ]{0,63}$/;

interface DiscoveredSkill {
  deviceId: string;
  root: string;
  dirName: string;
  /** Resolved on-disk directory (follows a top-level install symlink). */
  realDir: string;
  name: string;
  description: string;
  sizeBytes: number;
  mtimeLabel: string;
  dependencies: SkillDependency[];
  dependencyAnalysisError?: string;
  sourceDigest?: string;
  manifest?: SkillFileInfo[];
}

export interface ScannedSkill {
  deviceId: string;
  root: string;
  dirName: string;
  name: string;
  description: string;
  sizeBytes: number;
  mtimeLabel: string;
  dependencies: SkillDependency[];
  dependencyAnalysisError?: string;
  sourceDigest?: string;
  manifest?: SkillFileInfo[];
}

export interface SkillPackageContent {
  name: string;
  description: string;
  fileCount: number;
  byteSize: number;
  contentBase64: string;
  sourceDigest: string;
}

/** Expand a leading tilde against the daemon user's home directory. */
export function expandSkillRoot(root: string): string {
  const trimmed = root.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~" + sep)) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

interface Frontmatter {
  name?: unknown;
  description?: unknown;
}

function readSkillFrontmatter(skillMdPath: string): {
  name: string;
  description: string;
} {
  const raw = readFileSync(skillMdPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(raw);
  if (!match) return { name: "", description: "" };
  let parsed: Frontmatter = {};
  try {
    const value = parseYaml(match[1]!);
    if (value && typeof value === "object") parsed = value as Frontmatter;
  } catch {
    return { name: "", description: "" };
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name.trim() : "",
    description:
      typeof parsed.description === "string"
        ? parsed.description.trim().replace(/\s+/g, " ").slice(0, 600)
        : "",
  };
}

function formatMtime(mtimeMs: number): string {
  if (!mtimeMs) return "";
  return new Date(mtimeMs).toISOString();
}

/** Scan every root's immediate child directories for SKILL.md. */
/**
 * Resolve one root child to a real skill directory. Skills are commonly
 * installed as a top-level symlink to a managed store (e.g. ~/.agents/skills),
 * so a symlink-to-directory is followed exactly once here. Broken links and
 * links that do not point at a directory resolve to undefined; nested links
 * inside the target stay the traversal layer's responsibility.
 */
function resolveSkillDir(
  expandedRoot: string,
  child: Dirent,
): string | undefined {
  const logical = join(expandedRoot, child.name);
  try {
    if (child.isDirectory()) return logical;
    if (!child.isSymbolicLink()) return undefined;
    const real = realpathSync(logical);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export function scanSkillRoots(
  roots: string[],
  deviceId = "",
  analyzeDependencies = true,
): ScannedSkill[] {
  const discovered: DiscoveredSkill[] = [];

  // Pass 1: enumerate every skill and its resolved directory.
  for (const root of roots) {
    const expanded = expandSkillRoot(root);
    let children: Dirent[];
    try {
      children = readdirSync(expanded, { withFileTypes: true });
    } catch {
      continue; // A configured root may not exist yet; that is not an error.
    }
    for (const child of children) {
      const dirName = child.name;
      const skillPath = resolveSkillDir(expanded, child);
      if (!skillPath) continue;
      const skillMd = join(skillPath, SKILL_FILE_NAME);
      let skillMdStat;
      try {
        skillMdStat = lstatSync(skillMd);
      } catch {
        continue;
      }
      if (!skillMdStat.isFile()) continue;
      let frontmatter: { name: string; description: string };
      try {
        frontmatter = readSkillFrontmatter(skillMd);
      } catch {
        continue;
      }
      const name =
        frontmatter.name && VALID_SKILL_NAME.test(frontmatter.name)
          ? frontmatter.name
          : dirName;
      const sizeBytes = 0;
      const mtimeLabel = formatMtime(skillMdStat.mtimeMs);
      discovered.push({
        deviceId,
        root,
        dirName,
        realDir: skillPath,
        name,
        description: frontmatter.description,
        sizeBytes,
        mtimeLabel,
        dependencies: [],
      });
    }
  }

  if (!analyzeDependencies) return discovered;
  const known: KnownSkill[] = discovered.map((s) => ({
    name: s.name,
    dir: realpathSync(s.realDir),
    logicalDir: resolve(expandSkillRoot(s.root), s.dirName),
    root: s.root,
    dirName: s.dirName,
  }));
  const analyze = createSkillDependencyAnalyzer(known);
  const physical = new Map<string, number[]>();
  for (let i = 0; i < known.length; i++) {
    const dir = known[i]!.dir;
    physical.set(dir, [...(physical.get(dir) ?? []), i]);
  }
  for (const [dir, indices] of physical) {
    try {
      const inventory = readSkillInventory(dir);
      for (const i of indices) {
        const skill = discovered[i]!;
        skill.sizeBytes = inventory.sizeBytes;
        skill.mtimeLabel = formatMtime(inventory.mtimeMs);
        skill.sourceDigest = inventory.sourceDigest;
        skill.manifest = inventory.manifest;
        skill.dependencies = analyze(known[i]!, inventory.entries);
      }
    } catch (error) {
      for (const i of indices) {
        discovered[i]!.sizeBytes = -1;
        discovered[i]!.dependencyAnalysisError =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  return discovered;
}

/**
 * Read and zip one skill directory. The archive has no enclosing top-level
 * folder: its root is SKILL.md plus the skill's supporting files.
 */
export function packageSkillDirectory(
  root: string,
  dirName: string,
): SkillPackageContent {
  // Follow the (often symlinked) top-level install entry to its real tree.
  const logical = resolve(expandSkillRoot(root), dirName);
  let skillPath = logical;
  try {
    if (lstatSync(logical).isSymbolicLink()) {
      skillPath = realpathSync(logical);
    }
  } catch {
    throw new Error("skill directory not found");
  }
  const skillMd = join(skillPath, SKILL_FILE_NAME);
  const frontmatter = readSkillFrontmatter(skillMd);
  const inventory = readSkillInventory(skillPath);
  const entries = inventory.entries;
  const zip = packZip(entries);
  if (zip.length > SKILL_ARCHIVE_MAX_BYTES)
    throw new Error("Compressed skill package exceeds 64 MiB");
  return {
    name: frontmatter.name || dirName,
    description: frontmatter.description,
    fileCount: entries.length,
    byteSize: zip.length,
    contentBase64: zip.toString("base64"),
    sourceDigest: inventory.sourceDigest,
  };
}

export function toDeviceSkill(scanned: ScannedSkill): DeviceSkill {
  return {
    deviceId: scanned.deviceId,
    root: scanned.root,
    dirName: scanned.dirName,
    name: scanned.name,
    description: scanned.description,
    sizeBytes: scanned.sizeBytes,
    mtimeLabel: scanned.mtimeLabel,
    dependencies: scanned.dependencies,
    dependencyAnalysisError: scanned.dependencyAnalysisError,
    dependenciesAnalyzed:
      !!scanned.sourceDigest && !scanned.dependencyAnalysisError,
    sourceDigest: scanned.sourceDigest,
    manifest: scanned.manifest,
  };
}

/** Only the selected file is read when a user opens an inline comparison. */
export function readSkillTextFile(
  root: string,
  dirName: string,
  path: string,
): { content: string; digest: string } {
  assertSafeEntryPath(path);
  if (path.split("/").some((part) => !part || part === "."))
    throw new Error("Invalid skill file path");
  const dir = realpathSync(resolve(expandSkillRoot(root), dirName));
  let current = dir;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Nested skill symlinks are not readable");
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 512 * 1024)
    throw new Error(
      "File is too large for inline diff. Download the archive to inspect it.",
    );
  const data = readFileSync(current);
  if (data.length > 512 * 1024 || !isUtf8(data) || data.includes(0))
    throw new Error(
      "Binary or large file; download the archive to inspect it.",
    );
  return {
    content: data.toString("utf8"),
    digest: createHash("sha256").update(data).digest("hex"),
  };
}
