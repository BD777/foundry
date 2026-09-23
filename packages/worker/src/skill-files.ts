/** One inventory is shared by scanning, dependency analysis and packaging. */
import { isUtf8 } from "node:buffer";
import type { SkillFileInfo } from "@foundry/protocol";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZipEntry } from "./skill-zip.js";

// Bounds apply to complete packages, never silently truncate their contents.
export const SKILL_PACKAGE_MAX_BYTES = 256 << 20; // expanded content
export const SKILL_ARCHIVE_MAX_BYTES = 64 << 20; // compressed transport/storage
export const SKILL_PACKAGE_MAX_FILES = 50_000; // below the ZIP32 entry ceiling

export interface SkillInventory {
  entries: ZipEntry[];
  sizeBytes: number;
  mtimeMs: number;
  sourceDigest: string;
  manifest: SkillFileInfo[];
}

export function readSkillInventory(dir: string): SkillInventory {
  const entries: ZipEntry[] = [];
  let sizeBytes = 0;
  let mtimeMs = 0;
  function walk(at: string, prefix: string, depth: number) {
    if (depth > 128)
      throw new Error("Skill directory exceeds 128 nesting levels");
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.isSymbolicLink()) continue;
      const full = join(at, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, path, depth + 1);
      else if (entry.isFile()) {
        const stat = lstatSync(full);
        if (!stat.isFile())
          throw new Error(`Skill file changed while reading: ${path}`);
        if (entries.length >= SKILL_PACKAGE_MAX_FILES)
          throw new Error("Skill exceeds 50,000 files");
        if (sizeBytes + stat.size > SKILL_PACKAGE_MAX_BYTES)
          throw new Error("Skill exceeds 256 MiB of expanded content");
        const data = readFileSync(full);
        sizeBytes += data.length;
        if (sizeBytes > SKILL_PACKAGE_MAX_BYTES)
          throw new Error("Skill exceeds 256 MiB of expanded content");
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        entries.push({ path, data });
      }
    }
  }
  walk(dir, "", 0);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const { path, data } of entries)
    hash.update(`${path}\0${data.length}\0`).update(data);
  return {
    entries,
    sizeBytes,
    mtimeMs,
    sourceDigest: hash.digest("hex"),
    manifest: entries.map(({ path, data }) => ({
      path,
      digest: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
      binary: !isUtf8(data) || data.includes(0),
    })),
  };
}
