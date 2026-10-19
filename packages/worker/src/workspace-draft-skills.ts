/** Project-local discovery with bounded, stable reads and immutable snapshots. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import {
  materializeSkillSnapshot,
  type SnapshotFile,
} from "./skill-snapshots.js";
import { draftPackages } from "./workspace-draft-packages.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import {
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-files.js";

const roots = [".agents/skills", ".claude/skills", ".codex/skills"];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
interface DraftInput {
  item: WorkspaceDraftSkill;
  files: SnapshotFile[];
  dir: string;
}

function safePath(root: string, path: string): void {
  if (!inside(root, resolve(path)))
    throw new Error("Draft path leaves its execution root.");
  let at = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink())
      throw new Error("Draft symbolic links are not supported.");
  }
  if (!inside(root, realpathSync(path)))
    throw new Error("Draft path leaves its execution root.");
}

function readTree(root: string, dir: string): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  let size = 0;
  const walk = (at: string, depth: number) => {
    if (depth > 128) throw new Error("Draft exceeds 128 nesting levels.");
    safePath(root, at);
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, entry.name);
      safePath(root, path);
      const before = lstatSync(path);
      if (before.isDirectory()) walk(path, depth + 1);
      else if (before.isFile()) {
        if (
          files.length >= SKILL_PACKAGE_MAX_FILES ||
          size + before.size > SKILL_PACKAGE_MAX_BYTES
        )
          throw new Error("Draft package exceeds its file or byte limit.");
        const data = readFileSync(path);
        const after = lstatSync(path);
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          !after.isFile()
        )
          throw new Error("Draft changed while reading.");
        size += data.length;
        if (size > SKILL_PACKAGE_MAX_BYTES)
          throw new Error("Draft package exceeds its byte limit.");
        files.push({ path: relative(dir, path).split(sep).join("/"), data });
      } else throw new Error("Draft contains a non-regular file.");
    }
  };
  walk(dir, 0);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function draftContentDigest(files: SnapshotFile[]): string {
  const h = createHash("sha256");
  for (const { path, data } of files)
    h.update(`${path}\0${data.length}\0`).update(data);
  return h.digest("hex");
}
function stableTree(root: string, dir: string): SnapshotFile[] {
  for (let retry = 0; retry < 3; retry++) {
    const a = readTree(root, dir),
      b = readTree(root, dir);
    if (draftContentDigest(a) === draftContentDigest(b)) return b;
  }
  throw new Error("Draft is still changing; refresh when editing finishes.");
}

/** Does not scan any device-global directories or silently follow install links. */
export async function snapshotWorkspaceDrafts(
  workspaceId: string,
  executionRootId: string,
  workspacePath: string,
  storageRoot?: string,
  selected?: ManagedSkillRuntime,
): Promise<WorkspaceDraftSkill[]> {
  const root = realpathSync(workspacePath);
  const inputs: DraftInput[] = [];
  for (const relativeRoot of roots) {
    const folder = join(root, relativeRoot);
    let children;
    try {
      safePath(root, folder);
      children = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) continue;
      inputs.push({
        dir: folder,
        files: [],
        item: {
          id: hash(`${workspaceId}\0${executionRootId}\0${relativeRoot}`),
          workspaceId,
          executionRootId,
          name: relativeRoot,
          relativePath: relativeRoot,
          description: "",
          status: "invalid",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      const relativePath = `${relativeRoot}/${child.name}`,
        dir = join(root, relativePath);
      const item: WorkspaceDraftSkill = {
        id: hash(`${workspaceId}\0${executionRootId}\0${relativePath}`),
        workspaceId,
        executionRootId,
        name: child.name,
        relativePath,
        description: "",
        status: "ready",
      };
      const input: DraftInput = { item, files: [], dir };
      try {
        safePath(root, dir);
        try {
          lstatSync(join(dir, "SKILL.md"));
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        input.files = stableTree(root, dir);
        const body = input.files
          .find((f) => f.path === "SKILL.md")
          ?.data.toString("utf8");
        const front = body?.match(
          /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
        )?.[1];
        const meta = front ? parseYaml(front) : undefined;
        if (
          !meta ||
          typeof meta.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(meta.name)
        )
          throw new Error("Draft needs a valid name in SKILL.md frontmatter.");
        item.name = meta.name;
        item.description =
          typeof meta.description === "string"
            ? meta.description.replace(/\s+/g, " ").slice(0, 600)
            : "";
        item.digest = draftContentDigest(input.files);
      } catch (error) {
        item.status = "invalid";
        item.error = error instanceof Error ? error.message : String(error);
      }
      inputs.push(input);
    }
  }
  const ready = inputs.filter((i) => i.item.status === "ready");
  for (const input of ready) {
    const peers = ready.filter(
      (i) => i.item.name.toLowerCase() === input.item.name.toLowerCase(),
    );
    if (peers.length > 1) {
      input.item.status = "conflict";
      input.item.error =
        "Multiple draft folders have this name; choose one source by removing or renaming the duplicate.";
    }
  }
  const preparePackage = draftPackages(root, inputs, selected);
  for (const input of inputs.filter((i) => i.item.status === "ready")) {
    try {
      const prepared = preparePackage(input);
      input.item.sourceDigest = input.item.digest;
      input.files = prepared.files;
      input.item.digest = draftContentDigest(input.files);
      input.item.entryPath = prepared.entryPath;
    } catch (error) {
      input.item.status = "invalid";
      input.item.error = error instanceof Error ? error.message : String(error);
      continue;
    }
    const snapshot = await materializeSkillSnapshot(
      hash(`workspace-draft-v1\0${input.item.id}\0${input.item.digest}`),
      (directory) => ({ files: input.files, value: { directory } }),
      storageRoot,
    );
    input.item.snapshotRoot = snapshot.directory;
    input.item.snapshotPath = join(
      snapshot.directory,
      input.item.entryPath ?? "SKILL.md",
    );
    input.item.snapshotDigest = snapshot.snapshotDigest;
  }
  return inputs.map((i) => i.item);
}
