import { unpackZip } from "./skill-zip.js";
import type { DraftSkillTransfer } from "@bd777/foundry-protocol";
import { draftContentDigest } from "./workspace-draft-skills.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
/** Combines selected library inputs and trusted project snapshots for one turn. */
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import {
  materializeSkillSnapshot,
  readVerifiedSkillSnapshot,
} from "./skill-snapshots.js";
import {
  skillCatalog,
  type ManagedSkillRuntime,
  type ManagedSkill,
} from "./skill-materializer.js";
import { scanWorkspaceDrafts } from "./workspace-draft-scan-thread.js";

export async function withWorkspaceDraftSkills(
  selected: ManagedSkillRuntime,
  context: {
    workspaceId: string;
    executionRootId: string;
    workspacePath: string;
  },
): Promise<ManagedSkillRuntime> {
  const drafts = await scanWorkspaceDrafts(
    context.workspaceId,
    context.executionRootId,
    context.workspacePath,
    undefined,
    selected,
  );
  return combineWorkspaceDraftSkills(selected, drafts);
}

export async function combineWorkspaceDraftSkills(
  selected: ManagedSkillRuntime,
  drafts: WorkspaceDraftSkill[],
  transfers: DraftSkillTransfer[] = [],
): Promise<ManagedSkillRuntime> {
  if (!selected.snapshotDigest)
    throw new Error("Selected skills have no verified snapshot identity.");
  drafts = await Promise.all(
    drafts.map(async (draft) => {
      const transfer = transfers.find(
        (t) => t.id === draft.id && t.digest === draft.digest,
      );
      if (!transfer) return draft;
      const archive = Buffer.from(transfer.archiveBase64, "base64");
      if (
        archive.length > 64 * 1024 * 1024 ||
        createHash("sha256").update(archive).digest("hex") !== transfer.checksum
      )
        throw new Error("Draft transfer checksum mismatch.");
      const files = unpackZip(archive, {
        maxBytes: 256 * 1024 * 1024,
        maxFiles: 50000,
      }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (draftContentDigest(files) !== draft.digest)
        throw new Error(
          "Draft transfer content does not match the selected snapshot.",
        );
      const key = createHash("sha256")
        .update(JSON.stringify(["draft-transfer-v1", draft.id, draft.digest]))
        .digest("hex");
      const snapshot = await materializeSkillSnapshot(key, (directory) => ({
        files,
        value: { directory },
      }));
      return {
        ...draft,
        snapshotPath: join(snapshot.directory, draft.entryPath ?? "SKILL.md"),
        snapshotRoot: snapshot.directory,
        snapshotDigest: snapshot.snapshotDigest,
      };
    }),
  );
  const library = readVerifiedSkillSnapshot(
    selected.pluginDir,
    selected.snapshotDigest,
  );
  const ready = drafts.filter((d) => d.status === "ready");
  const inputs = ready.map((d) => {
    if (!d.snapshotPath || !d.snapshotDigest)
      throw new Error("Draft has no verified snapshot.");
    return {
      draft: d,
      files: readVerifiedSkillSnapshot(
        d.snapshotRoot ?? dirname(d.snapshotPath),
        d.snapshotDigest,
      ),
    };
  });
  const duplicateAliases = new Map<string, string[]>();
  const uniqueInputs = inputs.filter((input) => {
    const duplicate =
      !input.draft.entryPath &&
      selected.skills.find((skill) => {
        if (skill.name.toLowerCase() !== input.draft.name.toLowerCase())
          return false;
        const prefix =
          relative(selected.pluginDir, skill.dir).split("\\").join("/") + "/";
        const files = library
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return draftContentDigest(files) === input.draft.digest;
      });
    if (!duplicate) return true;
    duplicateAliases.set(duplicate.name, [
      ...(duplicateAliases.get(duplicate.name) ?? []),
      `draft:${input.draft.name}`,
    ]);
    return false;
  });
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "workspace-combined-v2",
        selected.snapshotDigest,
        ready.map((d) => [d.id, d.digest, d.snapshotDigest]),
      ]),
    )
    .digest("hex");
  const reserved = new Set([
    ...selected.skills.map((s) => s.name.toLowerCase()),
    "foundry",
    "skill-creator",
    "skill-installer",
    "openai-docs",
    "review-agent",
    "imagegen",
  ]);
  const result = await materializeSkillSnapshot(key, (dir) => {
    const files = library.filter((f) => !f.path.startsWith("skill-indexes/"));
    const skills: ManagedSkill[] = selected.skills.map((s) => ({
      ...s,
      dir: join(dir, relative(selected.pluginDir, s.dir)),
      aliases: [...(s.aliases ?? []), ...(duplicateAliases.get(s.name) ?? [])],
    }));
    for (const { draft, files: content } of uniqueInputs) {
      const name = `workspace-draft-${draft.id.slice(0, 16)}`;
      if (reserved.has(name.toLowerCase()))
        throw new Error(
          "Draft native invocation conflicts with a selected skill.",
        );
      const entry = draft.entryPath
        ? join("draft-content", draft.id, draft.entryPath)
        : join("skills", name, "SKILL.md");
      if (draft.entryPath) {
        for (const f of content)
          files.push({
            path: `draft-content/${draft.id}/${f.path}`,
            data: f.data,
          });
        files.push({
          path: `skills/${name}/SKILL.md`,
          data: Buffer.from(
            `---\n${stringifyYaml({ name, description: draft.description })}---\nRead and follow the method at ${join(dir, entry)}. Its package-relative references belong to this same immutable snapshot.\n`,
          ),
        });
      } else {
        for (const f of content)
          files.push({
            path: `skills/${name}/${f.path}`,
            data:
              f.path === "SKILL.md"
                ? nativeDraftDocument(f.data, name)
                : f.data,
          });
      }
      skills.push({
        name,
        invocationName: `draft:${draft.name}`,
        aliases: reserved.has(draft.name.toLowerCase()) ? [] : [draft.name],
        dir: dirname(join(dir, entry)),
        description: draft.description,
        draft,
      });
    }
    const value = skillCatalog(
      { pluginDir: dir, skills, draftsEnabled: true, draftSkills: drafts },
      (file, contents) =>
        files.push({
          path: relative(dir, file).split("\\").join("/"),
          data: Buffer.from(contents),
        }),
    );
    return { files, value };
  });
  return result;
}

function nativeDraftDocument(data: Buffer, name: string): Buffer {
  const text = data.toString("utf8");
  return Buffer.from(
    text.replace(
      /^---\r?\n([\s\S]*?)\r?\n---/,
      (_match, front: string) =>
        `---\n${stringifyYaml({ ...parseYaml(front), name })}---`,
    ),
  );
}
