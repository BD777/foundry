import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { foundryStatePath } from "../platform/state-root.js";
import { readJSONFile, writeFileAtomic } from "../platform/storage.js";
import { dirname, join } from "node:path";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import { prepareSkillContent } from "./skill-content-cache.js";
import { assertSafeEntryPath, type ZipEntry } from "./skill-zip.js";

function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(path).isDirectory())
      throw new Error(`Expected a workspace directory at ${path}`);
  }
}

interface CheckoutOrigin {
  directoryId: string;
  skillId: string;
  revision: number;
}

function receiptPath(workspace: string, relativePath: string): string {
  const key = createHash("sha256")
    .update(realpathSync(workspace))
    .update("\0")
    .update(relativePath)
    .digest("hex");
  return foundryStatePath("skill-checkouts", key + ".json");
}

function directoryId(path: string): string {
  const st = lstatSync(path, { bigint: true });
  return st.isDirectory() ? [st.dev, st.ino, st.birthtimeNs].join(":") : "";
}

// Receipts live outside the editable tree, and identify the directory
// instance. A replacement at the same path cannot inherit its predecessor.
export function checkoutOrigins(
  workspace: string,
  drafts: { relativePath: string }[],
): Record<string, CheckoutOrigin> {
  const origins: Record<string, CheckoutOrigin> = {};
  for (const { relativePath } of drafts) {
    if (!/^\.agents\/skills\/[^/\\]+$/.test(relativePath)) continue;
    const receipt = readJSONFile<CheckoutOrigin>(
      receiptPath(workspace, relativePath),
    );
    if (!receipt) continue;
    try {
      if (receipt.directoryId === directoryId(join(workspace, relativePath)))
        origins[relativePath] = receipt;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return origins;
}

export function writeCheckedOutSkill(
  workspace: string,
  name: string,
  files: ZipEntry[],
  ref: Pick<SessionSkillRef, "skillId" | "revision">,
): string {
  if (!name || name === "." || name === ".." || /[\\/:\0]/.test(name))
    throw new Error("Invalid Skill directory name.");
  const agents = join(realpathSync(workspace), ".agents");
  ensureDirectory(agents);
  const skills = join(agents, "skills");
  ensureDirectory(skills);
  const target = join(skills, name);
  // mkdir reserves even an empty target; a second checkout cannot replace it.
  mkdirSync(target, { mode: 0o700 });
  try {
    const id = directoryId(target);
    const origin: CheckoutOrigin = {
      directoryId: id,
      skillId: ref.skillId,
      revision: ref.revision,
    };
    writeFileAtomic(
      receiptPath(workspace, ".agents/skills/" + name),
      JSON.stringify(origin),
      { fsyncDirectory: true },
    );
    // The draft scanner discovers SKILL.md, so make it visible only after
    // every supporting file has been written.
    for (const entry of [...files].sort(
      (a, b) => Number(a.path === "SKILL.md") - Number(b.path === "SKILL.md"),
    )) {
      assertSafeEntryPath(entry.path);
      const file = join(target, entry.path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, entry.data, { flag: "wx", mode: 0o600 });
    }
    return id;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export async function checkoutWorkspaceSkill(
  workspace: string,
  ref: SessionSkillRef,
  serverURL: string,
): Promise<string> {
  const { files } = await prepareSkillContent(serverURL, ref);
  return writeCheckedOutSkill(workspace, ref.name, files, ref);
}
