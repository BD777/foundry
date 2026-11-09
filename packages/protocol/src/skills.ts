// Skills: device scans, the server library and its repositories and bundles,
// workspace selections, promotion and Foundry's built-in skills.

import type { WorkerRuntimeId } from "./profiles.js";
import type {
  DeviceSkill,
  SkillBundleTool,
  SkillDependency,
  SkillFileInfo,
} from "./contract.gen.js";
export type {
  DeviceSkill,
  PromotedSkill,
  SessionSkillBundle,
  SessionSkillRef,
  SkillBundleTool,
  SkillDependency,
  SkillDependencyStrength,
  SkillFileInfo,
  SkillPackRef,
  SkillToolAsset,
  SkillToolSetup,
} from "./contract.gen.js";

/**
 * Workspace skill isolation model.
 *
 * Flow is one-directional: a device scans its local roots, a skill is
 * promoted (uploaded) to the server catalog, and a workspace selects entries
 * from that catalog. Runtimes only ever see the workspace selection.
 */

/** A scan root configured on one device. Default roots live on the server. */
export interface DeviceSkillRoot {
  deviceId: string;
  path: string;
  isDefault: boolean;
}

/** Whether a device has a program some library skill needs. */
export interface DeviceTool {
  deviceId: string;
  tool: string;
  available: boolean;
  checkedAt: string;
  /** The version Foundry installed on the device, if it did. */
  version?: string;
}

/** A git repository the skill library takes skills from. */
export interface SkillRepository {
  id: string;
  /** The https remote. */
  url: string;
  /** Short form, e.g. "github.com/anthropics/skills". */
  label: string;
  /** Branch or tag followed; absent follows the default branch. */
  ref?: string;
  /** Folder within the repository holding the skills. */
  subpath?: string;
  /** Commit last seen at ref. */
  commit?: string;
  checkedAt?: string;
  error?: string;
  createdAt: string;
  skills: SkillRepositorySkill[];
  /** "pick": chosen skills; "bundle": the whole repository as one unit.
   * Either way the skills move to new versions by themselves. */
  mode: "pick" | "bundle";
  /** A bundle's name, e.g. "feishu-cli". */
  name?: string;
  /** The release tag (or branch and short commit) its skills are on. */
  version?: string;
  /** A rolled-back repository stays on its version until resumed. */
  paused?: boolean;
  /** Applied versions, newest first. */
  versions?: SkillBundleVersion[];
  /** Programs a bundle's skills run, with where to get them. */
  tools?: SkillBundleTool[];
  /** Programs named when the bundle was followed, which its source does
   * not publish itself (e.g. a Python CLI on PyPI). */
  declaredTools?: SkillToolDeclaration[];
  /** Skill folders the repository held when last read; absent if unknown. */
  foundCount?: number;
  /** The repository's own description from its host. */
  description?: string;
  /**
   * The device that reads the repository with its own git and npm settings
   * and credentials, for a source the server cannot reach; absent means the
   * server reads it.
   */
  fetchDeviceId?: string;
  fetchDeviceName?: string;
  /** Whether that device is connected now. */
  fetchDeviceOnline?: boolean;
  /**
   * The npm registry (https) its npm package and npm tools come from;
   * absent is the public registry when the server reads it, and the
   * device's own npm settings when a device does.
   */
  registry?: string;
  /** A check waits for the fetch device to come back online. */
  checkWaiting?: boolean;
  /**
   * How a bundle with tools moves devices to a new version: "auto" (the
   * default) starts a rollout when a version is followed, "manual" waits
   * for an Admin's Update.
   */
  updatePolicy?: "auto" | "manual";
  /** The latest rollout, finished or not. */
  rollout?: SkillBundleRollout;
  /**
   * Per device that reported one of the bundle's tools: the version it is
   * on, the one its sessions get skills from.
   */
  deviceVersions?: BundleDeviceVersion[];
}

/** The outcome of checking one bundle version on a device. */
export interface SkillBundleCheck {
  state: "passed" | "failed";
  deviceId: string;
  deviceName?: string;
  at: string;
  steps: SkillBundleCheckStep[];
  /** A drill: the check was made to fail after its real steps. */
  forced?: boolean;
}

/** One step of a check: `--version`, or one connector command. */
export interface SkillBundleCheckStep {
  name: string;
  /** "passed", "failed" or "skipped" (with why in detail). */
  state: "passed" | "failed" | "skipped";
  /** Why it failed or was skipped (redacted); never a passed step's output. */
  detail?: string;
  /** "version", or the command's declared result. */
  kind?: "version" | "status" | "refresh" | "read";
  /** The version, or the value at the command's show path. */
  value?: string;
  /** The connector a command checked, e.g. "Feishu". */
  service?: string;
}

/** One move of a bundle's devices to a version (docs/skills.md, Bundle 版本). */
export interface SkillBundleRollout {
  id: string;
  /** The bundle version moved to. */
  seq: number;
  tag: string;
  trigger: "auto" | "manual";
  /**
   * waiting (no device to start on is online), canary, rolling, done,
   * failed (a canary step broke before its check), rolled_back.
   */
  state: "waiting" | "canary" | "rolling" | "done" | "failed" | "rolled_back";
  canaryDeviceId?: string;
  devices: SkillBundleRolloutDevice[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** A rollback drill: the canary's check fails after its real steps. */
  failCheck?: boolean;
}

export interface SkillBundleRolloutDevice {
  deviceId: string;
  /** Its Foundry name now; "…" and an id tail tell two alike apart. */
  deviceName?: string;
  /** Whose device it is, when it is not the viewer's. */
  owner?: string;
  /** The tool versions it was on, e.g. "feishu-cli v1.41.0". */
  from?: string;
  state:
    | "pending"
    | "installing"
    | "checking"
    | "updated"
    | "failed"
    | "offline"
    | "rolled_back";
  error?: string;
  check?: SkillBundleCheck;
}

/** Where one device stands with a bundle. */
export interface BundleDeviceVersion {
  deviceId: string;
  /** The tool versions Foundry installed there, by tool. */
  tools: Record<string, string>;
  /** The bundle version its sessions get; absent when none matches. */
  seq?: number;
  tag?: string;
  /**
   * current: on the latest version; behind: on an older recorded version
   * (an update is available or waits); unknown: a tool version no recorded
   * version has (sessions get the latest skills, which may not match).
   */
  state: "current" | "behind" | "unknown";
  /** That version's check passed. */
  verified?: boolean;
}

/** A tool version a session runs, from run_session. */
export interface SessionToolPin {
  name: string;
  version: string;
  /** The bundle (repository) it came with. */
  bundleId?: string;
  bundle?: string;
  /** The version's rollout check passed. */
  verified?: boolean;
}

/** One version a bundle was updated or rolled back to. */
export interface SkillBundleVersion {
  seq: number;
  tag: string;
  commit: string;
  appliedAt: string;
  rolledBack?: boolean;
  added?: string[];
  changed?: string[];
  removed?: string[];
  /** Picked skills whose folder left the repository with this version;
   * the library keeps them at their last revision. */
  missing?: string[];
  members?: SkillBundleMember[];
  /** The programs this version needs; rolling back restores them. */
  tools?: SkillBundleTool[];
  /** Its check on a rollout's canary device. */
  check?: SkillBundleCheck;
}

/** One skill of a bundle version. */
export interface SkillBundleMember {
  dir: string;
  skillId: string;
  name: string;
  revision: number;
}

/**
 * A program a bundle declares that its source does not publish: "uv"
 * installs the PyPI package `package`, "npm" the npm package `package`
 * (from the repository's registry), which provides `command`. Its version
 * follows the bundle's when the package has it, else its latest.
 */
export interface SkillToolDeclaration {
  source: "uv" | "npm";
  package: string;
  command: string;
}

/** A bundle as workspaces choose it. */
export interface SkillBundleSummary {
  id: string;
  name: string;
  label: string;
  version?: string;
  /** The library skills it delivers now. */
  skillIds: string[];
}

/** A library skill taken from a repository folder. */
export interface SkillRepositorySkill {
  skillId: string;
  dir: string;
  /** Repository commit the skill's latest revision came from. */
  commit: string;
  /** The skill's name in the library. */
  name?: string;
  /** The skill left its bundle; sessions no longer get it. */
  retired?: boolean;
  /** A picked skill's folder is gone from the repository; the library
   * keeps its last revision. */
  missing?: boolean;
}

/** A skill folder found in a repository. */
export interface RepositorySkillFolder {
  dir: string;
  name: string;
  description: string;
  license?: string;
  /** Set when the folder is already in the library. */
  skillId?: string;
}

export interface SkillRepositoryView {
  repository: SkillRepository;
  available: RepositorySkillFolder[];
}

/** One row of a workspace's selection from the server skill catalog. */
export interface WorkspaceSkillBinding {
  workspaceId: string;
  skillId: string;
  /** Holds the workspace at one revision; absent or 0 follows the latest. */
  pinnedRevision?: number;
}

/**
 * A skill Foundry itself gives an agent runtime, beside the skills the agent
 * ships and the ones a workspace selects.
 */
export interface BuiltinSkill {
  runtime: Exclude<WorkerRuntimeId, "mock">;
  name: string;
  description?: string;
  /** Where it comes from, e.g. "Anthropic skills". */
  source: string;
}

/**
 * What the built-in foundry skill gives agents, for people: the Foundry
 * tools with what each does, its limits and the session roles that get it,
 * the guidance its SKILL.md gives, and that SKILL.md.
 */
export interface FoundrySkillDetail {
  name: string;
  description?: string;
  source: string;
  revisions: BuiltinSkillRevision[];
  tools: FoundryToolCapability[];
  guidance: SkillGuidanceSection[];
  /** The SKILL.md agents read. */
  manifest: string;
}

export interface BuiltinSkillRevision {
  runtime: Exclude<WorkerRuntimeId, "mock">;
  revision: number;
}

/**
 * The kinds of session whose Foundry tools differ: "session" is a chat, a
 * session an agent started, or a person at a shell.
 */
export type FoundryToolRole =
  | "session"
  | "issue_execution"
  | "issue_clarification"
  | "verifier"
  | "personal_agent";

export interface FoundryToolCapability {
  name: string;
  summary: string;
  limits: string[];
  readOnly: boolean;
  roles: FoundryToolRole[];
}

/** One section of a SKILL.md as points, one line each. */
export interface SkillGuidanceSection {
  heading: string;
  points: string[];
}

/** Reviewed device-local transitive promotion closure. */
export interface SkillPromotionPlan {
  digest: string;
  skills: DeviceSkill[];
  problems: string[];
  related: SkillDependency[];
}
export interface SkillPromotionResolution {
  root: string;
  dirName: string;
  /**
   * create: a new library skill; reuse: the identical library entry; update:
   * this device's version becomes the entry's next revision; keep: the
   * library entry stays as it is and nothing is published; fork: a new
   * library skill under another name.
   */
  action: "create" | "reuse" | "update" | "keep" | "fork";
  targetSkillId?: string;
  expectedRevision?: number;
  name?: string;
}
export interface SkillComparisonInput {
  deviceId: string;
  root: string;
  dirName: string;
  skillId: string;
  revision: number;
  sourceDigest: string;
  path?: string;
  side?: "local" | "server";
}
export interface SkillFileChange {
  path: string;
  kind: "added" | "removed" | "modified";
  before?: SkillFileInfo;
  after?: SkillFileInfo;
}
export interface SkillComparison {
  files: SkillFileChange[];
  unchanged: number;
  revision: number;
}
export interface SkillFileComparison {
  before: string;
  after: string;
  unavailable?: string;
}
