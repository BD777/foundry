// Skills: device scans, the server library and its repositories and bundles,
// workspace selections, promotion and Foundry's built-in skills.

import type { WorkerRuntimeId } from "./profiles.js";

export interface SkillPackRef {
  id: string;
  name: string;
  scope?: "workspace" | "issue" | "available";
  source?: string;
  version: string;
  workspaceId?: string;
}

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

/** One local skill observed by a device scan. */
export type SkillDependencyStrength = "required" | "related";

export interface SkillDependency {
  skillName: string;
  strength: SkillDependencyStrength;
  evidence: string;
  status?: "resolved" | "missing" | "ambiguous";
  targetRoot?: string;
  targetDirName?: string;
}

export interface DeviceSkill {
  manifest?: SkillFileInfo[];
  serverState?:
    | "unpublished"
    | "in_sync"
    | "different"
    | "reusable"
    | "name_conflict"
    | "unknown";
  serverRevision?: number;
  serverCandidates?: PromotedSkill[];
  deviceId: string;
  root: string;
  dirName: string;
  name: string;
  description: string;
  sizeBytes: number;
  mtimeLabel: string;
  /** Set once this exact entry has been promoted to the server catalog. */
  promotedSkillId?: string;
  /** Other installed skills this one references, inferred statically. */
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  dependenciesAnalyzed?: boolean;
  /** SHA-256 of the complete source tree used to build this graph node. */
  sourceDigest?: string;
}

/** A server catalog entry; content lives in immutable revisions. */
export interface PromotedSkill {
  sourceDigest?: string;
  usedByWorkspaces?: string[];
  id: string;
  name: string;
  description: string;
  originDeviceId: string;
  originDeviceLabel: string;
  originRoot: string;
  originDirName: string;
  latestRevision: number;
  createdLabel: string;
  updatedLabel: string;
  dependencies?: SkillDependency[];
  dependencyAnalysisError?: string;
  /** Programs the latest revision runs. */
  requires?: string[];
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
}

/** One skill of a bundle version. */
export interface SkillBundleMember {
  dir: string;
  skillId: string;
  name: string;
  revision: number;
}

/** A program a bundle needs, installable from its GitHub release. */
export interface SkillBundleTool {
  name: string;
  version: string;
  assets?: SkillToolAsset[];
  checksumsUrl?: string;
  /**
   * Where it installs from: absent (a GitHub release download), "npm" (the
   * npm package `package`) or "uv" (the Python package `package`, via uv).
   */
  source?: "npm" | "uv";
  package?: string;
  /**
   * Where an npm tool installs from: absent is the public registry, an
   * https URL that registry, "device" each device's own npm settings.
   */
  registry?: string;
  /** A step it needs after installing, run only when the person asks. */
  setup?: SkillToolSetup;
  /**
   * Arguments of the command a person runs once in a terminal on each
   * device after installing (e.g. ["auth", "login"]); Foundry only shows it.
   */
  signIn?: string[];
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

/** Runs one of the installed package's commands with fixed arguments. */
export interface SkillToolSetup {
  /** A command the package installs; absent is the tool itself. */
  command?: string;
  args: string[];
  /** What it does, e.g. "Downloads Chrome for Testing". */
  description: string;
}

/** One platform's download of a tool. */
export interface SkillToolAsset {
  os: string;
  arch: string;
  name: string;
  url: string;
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

/** A resolved (skill, revision) pair attached to a dispatched session. */
export interface SessionSkillRef {
  skillId: string;
  revision: number;
  name: string;
  checksum: string;
  byteSize: number;
  /** Trusted expanded-content digest; older servers omit it. */
  sourceDigest?: string;
  /** The bundle the skill came with, so a session can be told about a large
   * bundle as one entry instead of skill by skill. */
  bundle?: SessionSkillBundle;
}

/** The bundle a session skill came with. */
export interface SessionSkillBundle {
  id: string;
  name: string;
  description?: string;
  version?: string;
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

export interface SkillFileInfo {
  path: string;
  digest: string;
  sizeBytes: number;
  binary: boolean;
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
