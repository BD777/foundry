/**
 * Materializes a session's resolved skill selection into one content-addressed
 * runtime tree the CLIs can load:
 *
 *   <state>/skill-sets/<setHash>/
 *     .claude-plugin/plugin.json   (Claude Code local plugin)
 *     skills/<name>/SKILL.md ...   (every selected revision, verified)
 *
 * Packages are fetched from the server once per revision, checksum verified,
 * retained as checksum-verified archives. Expanded caches are authenticated
 * by the server revision sourceDigest on every reuse; legacy refs use ZIPs.
 * Every reuse verifies the generated tree against authenticated content,
 * including scripts and plugin metadata. Sets get copies,
 * not links: a sandboxed agent may read the skill sets only. Nothing here
 * touches the user's own skill directories.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  materializeSkillSnapshot,
  type SnapshotFile,
} from "./skill-snapshots.js";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import {
  prepareSkillContent,
  type SkillContentOptions,
} from "./skill-content-cache.js";

export interface ManagedSkill {
  name: string;
  invocationName?: string;
  aliases?: string[];
  draft?: import("@bd777/foundry-protocol").WorkspaceDraftSkill;
  /** Contains SKILL.md. */
  dir: string;
}

export interface ManagedSkillRuntime {
  draftSkills?: import("@bd777/foundry-protocol").WorkspaceDraftSkill[];
  draftsEnabled?: boolean;
  pluginDir: string;
  snapshotDigest?: string;
  manifestFile?: string;
  /** Selected skills; each agent discovers them natively. */
  skills: ManagedSkill[];
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

export interface SkillPreparationStats {
  total: number;
  completed: number;
  expandedCache: number;
  archiveCache: number;
  downloaded: number;
  verifyMs: number;
  downloadMs: number;
  unpackMs: number;
  snapshotMs: number;
  elapsedMs: number;
}
export interface SkillPreparationOptions extends SkillContentOptions {
  onProgress?: (stats: SkillPreparationStats) => void | Promise<void>;
  onComplete?: (stats: SkillPreparationStats) => void | Promise<void>;
}

/** Prepare reusable package content without constructing a session allowlist. */
export async function prepareSkillContents(
  refs: SessionSkillRef[],
  serverURL: string,
  options: SkillPreparationOptions = {},
) {
  const started = performance.now();
  const stats: SkillPreparationStats = {
    total: refs.length,
    completed: 0,
    expandedCache: 0,
    archiveCache: 0,
    downloaded: 0,
    verifyMs: 0,
    downloadMs: 0,
    unpackMs: 0,
    snapshotMs: 0,
    elapsedMs: 0,
  };
  const packages = await mapConcurrent(
    refs,
    fetchConcurrency,
    async (ref, signal) => {
      const result = await prepareSkillContent(serverURL, ref, {
        ...options,
        signal,
      });
      stats.completed++;
      stats[
        result.source === "expanded-cache"
          ? "expandedCache"
          : result.source === "archive-cache"
            ? "archiveCache"
            : "downloaded"
      ]++;
      stats.verifyMs += result.verifyMs;
      stats.downloadMs += result.downloadMs;
      stats.unpackMs += result.unpackMs;
      stats.elapsedMs = performance.now() - started;
      await options.onProgress?.({ ...stats });
      return result.files;
    },
    options.signal,
  );
  return { packages, stats };
}

/** Revisions fetched at once when a set needs several. */
const fetchConcurrency = 8;

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  run: (item: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      try {
        while (next < items.length && !controller.signal.aborted) {
          const index = next++;
          results[index] = await run(items[index]!, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
      }
    },
  );
  try {
    await Promise.all(lanes);
    controller.signal.throwIfAborted();
    return results;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Claude Code namespaces plugin skills: `/name` typed for a workspace skill
 * becomes `/foundry-workspace:name`. Any other command is left to Claude Code.
 */
export function claudeManagedPrompt(
  prompt: string,
  managed: ManagedSkillRuntime | undefined,
): string {
  if (!managed) return prompt;
  return prompt.replace(/^\s*\/([\w:-]+)(?=\s|$)/, (match, name: string) => {
    const skill = managed.skills.find(
      (skill) =>
        skill.name === name ||
        skill.invocationName === name ||
        skill.aliases?.includes(name),
    );
    return skill ? `/foundry-workspace:${skill.name}` : match;
  });
}

/**
 * Ensure the selected revisions are present on disk and return the runtime
 * tree. An empty selection returns a ready but empty tree (default-deny).
 */
export async function materializeSessionSkills(
  refs: SessionSkillRef[] | undefined,
  serverURL: string,
  workspaceCwd: string,
  options: SkillPreparationOptions = {},
): Promise<ManagedSkillRuntime> {
  options.signal?.throwIfAborted();
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

  const started = performance.now();
  const { packages, stats } = await prepareSkillContents(
    ordered,
    serverURL,
    options,
  );
  options.signal?.throwIfAborted();
  const snapshotStarted = performance.now();
  const runtime = await materializeSkillSnapshot(setHash(ordered), (dir) => {
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
      };
    });
    return { files, value: { pluginDir: dir, skills } };
  });
  stats.snapshotMs = performance.now() - snapshotStarted;
  stats.elapsedMs = performance.now() - started;
  await options.onComplete?.({ ...stats });
  return runtime;
}
