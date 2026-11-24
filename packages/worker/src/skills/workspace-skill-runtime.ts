import { stringify as stringifyYaml } from "yaml";
/** Combines selected library inputs and trusted project snapshots for one turn. */
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import {
  materializeSkillSnapshot,
  readVerifiedSkillSnapshot,
} from "./skill-snapshots.js";
import type {
  ManagedSkillRuntime,
  ManagedSkill,
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
): Promise<ManagedSkillRuntime> {
  if (!selected.snapshotDigest)
    throw new Error("Selected skills have no verified snapshot identity.");
  const library = readVerifiedSkillSnapshot(
    selected.pluginDir,
    selected.snapshotDigest,
  );
  const builtins = new Set(
    selected.skills.filter((s) => s.builtin).map((s) => s.name.toLowerCase()),
  );
  const ready = drafts.filter(
    (d) => d.status === "ready" && !builtins.has(d.name.toLowerCase()),
  );
  const draftNames = new Set(ready.map((d) => d.name.toLowerCase()));
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
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "workspace-combined-v3",
        selected.snapshotDigest,
        ready.map((d) => [d.id, d.digest, d.snapshotDigest]),
      ]),
    )
    .digest("hex");
  const shadowedPrefixes = selected.skills
    .filter((skill) => draftNames.has(skill.name.toLowerCase()))
    .map(
      (skill) =>
        relative(selected.pluginDir, skill.dir).split(sep).join("/") + "/",
    );
  const result = await materializeSkillSnapshot(key, (dir) => {
    const files = library.filter(
      (file) =>
        !shadowedPrefixes.some((prefix) => file.path.startsWith(prefix)),
    );
    const skills: ManagedSkill[] = selected.skills
      .filter((s) => !draftNames.has(s.name.toLowerCase()))
      .map((s) => ({
        ...s,
        dir: join(dir, relative(selected.pluginDir, s.dir)),
      }));
    for (const { draft, files: content } of inputs) {
      const name = draft.name;
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
            data: f.data,
          });
      }
      skills.push({
        name,
        invocationName: `draft:${draft.name}`,
        aliases: [name],
        dir: dirname(join(dir, entry)),
        draft,
      });
    }
    return {
      files,
      value: {
        pluginDir: dir,
        skills,
        draftsEnabled: true,
        draftSkills: drafts,
      },
    };
  });
  return result;
}
