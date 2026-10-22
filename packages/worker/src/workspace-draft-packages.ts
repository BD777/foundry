/** Resolve explicit draft dependencies into a self-contained, stable project tree. */
import { dirname, join, relative } from "node:path";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import { createSkillDependencyAnalyzer } from "./skill-dependencies.js";
import {
  readVerifiedSkillSnapshot,
  type SnapshotFile,
} from "./skill-snapshots.js";
import {
  SKILL_PACKAGE_MAX_BYTES,
  SKILL_PACKAGE_MAX_FILES,
} from "./skill-files.js";
export interface DraftSource {
  item: WorkspaceDraftSkill;
  files: SnapshotFile[];
  dir: string;
}
interface Source {
  name: string;
  dir: string;
  root: string;
  dirName: string;
  files: SnapshotFile[];
  draft?: DraftSource;
}
export function draftPackages(
  root: string,
  drafts: DraftSource[],
  selected?: ManagedSkillRuntime,
) {
  const sources: Source[] = drafts
    .filter((d) => d.item.status === "ready")
    .map((d) => ({
      name: d.item.name,
      dir: d.dir,
      root,
      dirName: d.item.relativePath,
      files: d.files,
      draft: d,
    }));
  if (selected?.snapshotDigest && sources.length > 0) {
    let cachedFiles: SnapshotFile[] | undefined;
    const getLibraryFiles = (prefix: string) => {
      if (!cachedFiles && selected.snapshotDigest) {
        cachedFiles = readVerifiedSkillSnapshot(
          selected.pluginDir,
          selected.snapshotDigest,
        );
      }
      return (cachedFiles ?? [])
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    };
    for (const skill of selected.skills) {
      const prefix =
        relative(selected.pluginDir, skill.dir).split("\\").join("/") + "/";
      sources.push({
        name: skill.name,
        dir: skill.dir,
        root: dirname(skill.dir),
        dirName: skill.name,
        get files() {
          return getLibraryFiles(prefix);
        },
      });
    }
  }
  const analyze = createSkillDependencyAnalyzer(sources);
  const links = new Map<Source, { target: Source; offset?: string }[]>();
  const errors = new Map<Source, string>();
  for (const source of sources.filter((s) => s.draft)) {
    const targets: { target: Source; offset?: string }[] = [];
    for (const dep of analyze(source, source.files).filter(
      (d) => d.strength === "required",
    )) {
      if (/(?:^|[\s("'`])(?:\/|~\/|\$HOME\/)/.test(dep.evidence)) {
        errors.set(
          source,
          "Use package-relative cross-Skill paths so the draft can retain exact dependency snapshots.",
        );
        break;
      }
      let target = sources.find(
        (s) => s.root === dep.targetRoot && s.dirName === dep.targetDirName,
      );
      // A named method keeps the selected library meaning when a same-name draft exists.
      if (!target && dep.status === "ambiguous")
        target = sources.find((s) => !s.draft && s.name === dep.skillName);
      if (!target) {
        errors.set(
          source,
          `Required Skill dependency "${dep.skillName}" is missing or ambiguous in this workspace.`,
        );
        break;
      }
      let offset: string | undefined;
      if (!target.draft) {
        const file = source.files.find((f) =>
          dep.evidence.startsWith(f.path + ":"),
        );
        for (const match of dep.evidence.matchAll(
          /(?:^|[\s("'`])((?:\.\.?\/)[\w./-]+)/g,
        )) {
          const parts = match[1]!.split("/"),
            index = parts.indexOf(target.name);
          if (file && index >= 0) {
            offset = join(
              dirname(file.path),
              parts.slice(0, index + 1).join("/"),
            );
            break;
          }
        }
      }
      targets.push({ target, offset });
    }
    links.set(source, targets);
  }
  return (
    draft: DraftSource,
  ): { files: SnapshotFile[]; entryPath?: string } => {
    const own = sources.find((s) => s.draft === draft);
    if (!own) throw new Error("Draft source is unavailable.");
    if (errors.has(own)) throw new Error(errors.get(own));
    if (!links.get(own)?.length) return { files: own.files };
    const files = new Map<string, Buffer>();
    const seen = new Set<string>();
    let bytes = 0;
    const collect = (source: Source, at: string) => {
      if (at === ".." || at.startsWith("../") || at.startsWith("/"))
        throw new Error("Draft dependency leaves its execution root.");
      if (errors.has(source)) throw new Error(errors.get(source));
      const identity = source.dir + "\0" + at;
      if (seen.has(identity)) return;
      seen.add(identity);
      if (seen.size > 500)
        throw new Error("Draft dependency closure exceeds 500 packages.");
      for (const f of source.files) {
        const path = `project/${at}/${f.path}`,
          prior = files.get(path);
        if (prior && !prior.equals(f.data))
          throw new Error(
            "Draft dependencies conflict at the same project path.",
          );
        if (!prior) {
          bytes += f.data.length;
          files.set(path, f.data);
        }
        if (
          files.size > SKILL_PACKAGE_MAX_FILES ||
          bytes > SKILL_PACKAGE_MAX_BYTES
        )
          throw new Error("Draft dependency closure exceeds package limits.");
      }
      for (const edge of links.get(source) ?? [])
        collect(
          edge.target,
          edge.target.draft?.item.relativePath ??
            (edge.offset
              ? join(at, edge.offset)
              : join(dirname(at), edge.target.name)
            )
              .split("\\")
              .join("/"),
        );
    };
    collect(own, draft.item.relativePath);
    return {
      entryPath: `project/${draft.item.relativePath}/SKILL.md`,
      files: [...files]
        .map(([path, data]) => ({ path, data }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  };
}
