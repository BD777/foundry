/**
 * Materializes a session's resolved skill selection into one content-addressed
 * runtime tree the CLIs can load:
 *
 *   <state>/skill-sets/<setHash>/
 *     .claude-plugin/plugin.json   (Claude Code local plugin)
 *     skills/<name>/SKILL.md ...   (every selected revision, verified)
 *
 * Packages are fetched from the server once per (skill, revision), checksum
 * verified, and unpacked with the zip safety rules in skill-zip. Nothing here
 * touches the user's own skill directories.
 */

import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionSkillRef } from "@foundry/protocol";
import { daemonRequestHeaders } from "./transport.js";
import {
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-scanner.js";
import { foundryStatePath } from "./state-root.js";
import { unpackZip } from "./skill-zip.js";

export interface ManagedSkillRuntime {
  pluginDir: string;
  /** Selected skills as `{ name, dir }`, dir containing SKILL.md. */
  skills: { name: string; dir: string; description?: string }[];
  /** Native runtime inventory, populated before Codex execution. */
  hostSkillPaths?: string[];
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
): void {
  const staging = `${targetDir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of entries) {
    const full = join(staging, entry.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, entry.data);
  }
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(staging, targetDir);
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
  const skills: ManagedSkillRuntime["skills"] = [];
  let needsPluginFile = !existsSync(pluginMarker);

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
    const targetDir = join(skillsRoot, name);
    const checksumFile = join(targetDir, ".foundry-skill-checksum");
    if (
      existsSync(join(targetDir, "SKILL.md")) &&
      readFileSync(checksumFile, "utf8") === ref.checksum
    ) {
      skills.push({
        name,
        dir: targetDir,
        description: skillDescription(targetDir),
      });
      continue;
    }
    const zip = await fetchSkillPackage(serverURL, ref);
    const entries = unpackZip(zip, {
      // fetchSkillPackage has already verified the immutable revision SHA-256.
      allowLegacyCrc: true,
      maxBytes: SKILL_PACKAGE_MAX_BYTES,
      maxFiles: SKILL_PACKAGE_MAX_FILES,
    });
    if (!entries.some((entry) => entry.path === "SKILL.md")) {
      throw new Error(
        `promoted skill ${ref.skillId} is missing a root SKILL.md`,
      );
    }
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeUnpacked(targetDir, entries);
    writeFileSync(checksumFile, ref.checksum);
    skills.push({
      name,
      dir: targetDir,
      description: skillDescription(targetDir),
    });
  }

  if (needsPluginFile) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      pluginMarker,
      JSON.stringify({ name: "foundry-workspace", version: "0.1.0" }, null, 2),
    );
  }

  return {
    pluginDir: dir,
    skills,
  };
}
