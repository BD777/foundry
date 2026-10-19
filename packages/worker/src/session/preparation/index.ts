/** Shared preparation for workspace turns and independent judgments. */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { privateConfigurationVersion } from "../../agent-runtime/private-identity.js";
import type { AgentSession } from "@bd777/foundry-protocol";
import { resolveSessionContextWindow } from "../../context-window.js";
import { nativeCli } from "../../native-cli.js";
import { profileID, type AgentProfileLocalConfig } from "../../profiles.js";
import { sessionEnvironment } from "../../session-ambient.js";
import { codexSessionEnvironment } from "../../runner/codex-options.js";
import { prepareCodexSkillIsolation } from "../../skill-isolation.js";
import type { ManagedSkillRuntime } from "../../skill-materializer.js";
import { nativeExecutionPaths } from "../../runtime-isolation.js";

export interface ExecutionRequest {
  purpose: "workspace" | "independent_judge";
  ownerId: string;
  workspacePath: string;
  profile: AgentProfileLocalConfig;
  model?: string;
  session?: AgentSession;
  managedSkills?: ManagedSkillRuntime;
  signal?: AbortSignal;
  /** A judge supplies its restricted environment; it never receives chat tools. */
  environment?: (profile: AgentProfileLocalConfig) => NodeJS.ProcessEnv;
}

export interface ExecutionManifest {
  version: 1;
  purpose: ExecutionRequest["purpose"];
  ownerId: string;
  workspacePath: string;
  profileId: string;
  runtime: "claude" | "codex";
  model?: string;
  contextWindow?: AgentProfileLocalConfig["contextWindow"];
  runtimeGeneration?: string;
  connectionVersion: string;
  skills: { name: string; path: string }[];
  skillSnapshotDigest?: string;
  paths?: ReturnType<typeof nativeExecutionPaths>;
}

export interface PreparedExecution {
  manifest: Readonly<ExecutionManifest>;
  native: {
    profile: AgentProfileLocalConfig;
    env: NodeJS.ProcessEnv;
    managedSkills?: ManagedSkillRuntime;
  };
  readRoots: string[];
  /** The runtime retains its inputs when it outlives the requesting turn. */
  retain(): () => Promise<void>;
  /** Register a private input while this preparation is still owned. */
  own(release: () => void | Promise<void>): void;
  dispose(): Promise<void>;
}

export interface PreparationPorts {
  resolveWindow?: typeof resolveSessionContextWindow;
  inventory?: typeof prepareCodexSkillIsolation;
  cleanup?: () => void | Promise<void>;
}

export function executionReuseIdentity(manifest: ExecutionManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export async function prepareExecution(
  request: ExecutionRequest,
  ports: PreparationPorts = {},
): Promise<PreparedExecution> {
  const resources: (() => void | Promise<void>)[] = [];
  let references = 1;
  let initialReleased = false;
  let cleanup: Promise<void> | undefined;
  const release = () => {
    references--;
    if (references === 0)
      cleanup = (async () => {
        const results = await Promise.allSettled(
          resources.reverse().map((release) => Promise.resolve().then(release)),
        );
        await ports.cleanup?.();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
    return cleanup ?? Promise.resolve();
  };
  const dispose = () => {
    if (initialReleased) return cleanup ?? Promise.resolve();
    initialReleased = true;
    return release();
  };
  const retain = () => {
    if (references === 0)
      throw new Error("Prepared execution has been disposed.");
    references++;
    let released = false;
    return () => {
      if (released) return cleanup ?? Promise.resolve();
      released = true;
      return release();
    };
  };
  try {
    const requestedProfile = structuredClone(request.profile);
    request.signal?.throwIfAborted();
    const model =
      request.model?.trim() ||
      request.session?.model?.trim() ||
      requestedProfile.model?.trim() ||
      "";
    const contextWindow =
      requestedProfile.contextWindow?.model === model
        ? requestedProfile.contextWindow
        : await (ports.resolveWindow ?? resolveSessionContextWindow)(
            requestedProfile,
            model,
          );
    const profile = { ...requestedProfile, model, contextWindow };
    request.signal?.throwIfAborted();
    const env = request.environment
      ? request.environment(profile)
      : profile.runtime === "codex"
        ? codexSessionEnvironment(
            request.workspacePath,
            profile,
            request.session,
            request.ownerId,
          )
        : sessionEnvironment(
            request.workspacePath,
            profile,
            request.session,
            request.ownerId,
          );
    // A judgment never loads candidate methods as instructions.
    let managedSkills =
      request.purpose === "workspace" ? request.managedSkills : undefined;
    if (managedSkills && profile.runtime === "codex")
      managedSkills = await (ports.inventory ?? prepareCodexSkillIsolation)(
        managedSkills,
        request.workspacePath,
        env,
        request.signal,
      );
    request.signal?.throwIfAborted();
    const manifest: ExecutionManifest = {
      version: 1,
      purpose: request.purpose,
      ownerId: request.ownerId,
      workspacePath: request.workspacePath,
      profileId: profileID(profile),
      runtime: profile.runtime,
      model: model || undefined,
      contextWindow,
      runtimeGeneration: nativeCli(profile.runtime).generation,
      connectionVersion: privateConfigurationVersion(profile),
      skills: (managedSkills?.skills ?? []).map((skill) => ({
        name: skill.name,
        path: skill.dir,
      })),
      skillSnapshotDigest: managedSkills?.snapshotDigest,
      paths: nativeExecutionPaths(env),
    };
    const publicManifest = freezeManifest(structuredClone(manifest));
    const prepared = {
      manifest: publicManifest,
      native: { profile, env, managedSkills },
      readRoots: managedSkills
        ? [
            managedSkills.pluginDir,
            ...(managedSkills.officialSkills ?? []).flatMap((s) =>
              s.path ? [dirname(s.path)] : [],
            ),
          ]
        : [],
      dispose,
      retain,
      own: (release: () => void | Promise<void>) => {
        if (initialReleased)
          throw new Error("Prepared execution no longer accepts inputs.");
        resources.push(release);
      },
      toJSON: () => ({ manifest: publicManifest }),
    };
    return prepared;
  } catch (error) {
    await dispose();
    request.signal?.throwIfAborted();
    throw error;
  }
}

function freezeManifest<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeManifest(item);
    Object.freeze(value);
  }
  return value;
}
