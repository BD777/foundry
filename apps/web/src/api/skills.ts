import type {
  DeviceSkill,
  DeviceSkillRoot,
  FoundrySkillDetail,
  PromotedSkill,
  RepositorySkillFolder,
  SkillComparison,
  SkillComparisonInput,
  SkillFileComparison,
  SkillPromotionPlan,
  SkillPromotionResolution,
  SkillRepository,
  SkillRepositoryView,
  SkillToolDeclaration,
  WorkspaceSkillBinding,
} from "@bd777/foundry-protocol";
import { request, send, type RequestOptions } from "./http";

const workspacePath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}`;
const repositoryPath = (id: string) =>
  `/api/skill-repositories/${encodeURIComponent(id)}`;

// --- Workspace skill isolation ---

export interface DeviceSkillsSnapshot {
  roots: DeviceSkillRoot[];
  skills: DeviceSkill[];
}

export function listDeviceSkills(
  deviceId: string,
): Promise<DeviceSkillsSnapshot> {
  return request(
    "GET",
    `/api/device-skills?deviceId=${encodeURIComponent(deviceId)}`,
  );
}

export function scanDeviceSkills(deviceId: string): Promise<DeviceSkill[]> {
  return request(
    "POST",
    `/api/device-skills/scan?deviceId=${encodeURIComponent(deviceId)}`,
    { body: {} },
  );
}

export function setDeviceSkillRoots(
  deviceId: string,
  paths: string[],
): Promise<DeviceSkillRoot[]> {
  return request(
    "PUT",
    `/api/devices/${encodeURIComponent(deviceId)}/skill-roots`,
    { body: { deviceId, paths } },
  );
}

export function previewSkillPromotion(input: {
  deviceId: string;
  root: string;
  dirName: string;
  includeRelated?: string[];
  resolutions?: SkillPromotionResolution[];
}): Promise<SkillPromotionPlan> {
  return request("POST", "/api/skills/promote-plan", { body: input });
}

export function promoteSkill(input: {
  deviceId: string;
  root: string;
  dirName: string;
  resolutions?: SkillPromotionResolution[];
  planDigest?: string;
  includeRelated?: string[];
}): Promise<PromotedSkill> {
  return request("POST", "/api/skills/promote", { body: input });
}

export function setWorkspaceSkills(
  workspaceId: string,
  skillIds: string[],
  offSkillIds?: string[],
): Promise<WorkspaceSkillBinding[]> {
  return request("PUT", `${workspacePath(workspaceId)}/skills`, {
    body: { workspaceId, skillIds, offSkillIds },
  });
}

/** Holds a workspace's skill at one revision; 0 follows the latest again. */
export function setWorkspaceSkillPin(
  workspaceId: string,
  skillId: string,
  revision: number,
): Promise<WorkspaceSkillBinding[]> {
  return request(
    "PUT",
    `${workspacePath(workspaceId)}/skills/${encodeURIComponent(skillId)}/pin`,
    { body: { revision } },
  );
}

export function setWorkspaceSkillBundles(
  workspaceId: string,
  bundleIds: string[],
): Promise<{ bundleIds: string[] }> {
  return request("PUT", `${workspacePath(workspaceId)}/skill-bundles`, {
    body: { bundleIds },
  });
}

/** The library skills the signed-in person gives every workspace they own. */
export interface MyDefaultSkills {
  skillIds: string[];
  bundleIds?: string[];
}

export function listMyDefaultSkills(): Promise<MyDefaultSkills> {
  return request("GET", "/api/me/default-skills");
}

/** Replaces the default skills, and the default bundles when given. */
export function setMyDefaultSkills(
  skillIds: string[],
  bundleIds?: string[],
): Promise<MyDefaultSkills> {
  return request("PUT", "/api/me/default-skills", {
    body: { skillIds, ...(bundleIds ? { bundleIds } : {}) },
  });
}

/** What the built-in foundry skill gives agents: its tools, guidance and SKILL.md. */
export function getFoundrySkill(
  options: RequestOptions = {},
): Promise<FoundrySkillDetail> {
  return request("GET", "/api/builtin-skills/foundry", options);
}

export function compareSkillVersions(
  input: SkillComparisonInput,
  options: RequestOptions = {},
): Promise<SkillComparison> {
  return request("POST", "/api/skills/compare", {
    body: input,
    signal: options.signal,
  });
}

export function compareSkillFile(
  input: SkillComparisonInput & { path: string },
  options: RequestOptions = {},
): Promise<SkillFileComparison> {
  return request("POST", "/api/skills/compare-file", {
    body: input,
    signal: options.signal,
  });
}

export async function downloadSkillComparisonPackage(
  input: SkillComparisonInput & { side: "local" | "server" },
): Promise<Blob> {
  const response = await send("POST", "/api/skills/compare-package", {
    body: input,
  });
  return response.blob();
}

// --- Skill repositories ---

export function listSkillRepositories(): Promise<SkillRepository[]> {
  return request("GET", "/api/skill-repositories");
}

export interface SkillRepositoryPreview {
  label: string;
  name: string;
  available: RepositorySkillFolder[];
  /** The skills look like one set (shared name prefix or a manifest). */
  suggestBundle: boolean;
  /** The newest release tag, when the repository has one. */
  release?: string;
}

/** Where a repository is read: a device ("" is the server) and its npm registry. */
export interface SkillRepositorySource {
  deviceId?: string;
  registry?: string;
}

/** Reads a repository without following it. */
export function previewSkillRepository(
  input: {
    url: string;
    ref: string;
    subpath: string;
  } & SkillRepositorySource,
): Promise<SkillRepositoryPreview> {
  const query = new URLSearchParams(
    Object.entries(input).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  ).toString();
  return request("GET", `/api/skill-repositories/preview?${query}`);
}

/** Follows a repository: chosen skills (pick) or all of it (bundle). */
export function addSkillRepository(
  input: {
    url: string;
    ref: string;
    subpath: string;
    mode?: "pick" | "bundle";
    dirs?: string[];
    /** The bundle's name; the server derives one when empty. */
    name?: string;
    /** Programs a bundle needs that its source does not publish. */
    tools?: SkillToolDeclaration[];
  } & SkillRepositorySource,
): Promise<SkillRepositoryView> {
  return request("POST", "/api/skill-repositories", { body: input });
}

/** Changes where a followed repository is read, and checks it there. */
export function setSkillRepositorySource(
  id: string,
  source: SkillRepositorySource,
): Promise<SkillRepository> {
  return request("PUT", `${repositoryPath(id)}/source`, {
    body: { deviceId: source.deviceId ?? "", registry: source.registry ?? "" },
  });
}

export function rollbackSkillBundle(
  id: string,
  seq: number,
): Promise<SkillRepository> {
  return request("POST", `${repositoryPath(id)}/rollback`, { body: { seq } });
}

/** Turns a repository followed by picking skills into a bundle. */
export function followRepositoryAsBundle(id: string): Promise<SkillRepository> {
  return request("POST", `${repositoryPath(id)}/mode`, {
    body: { mode: "bundle" },
  });
}

export function resumeSkillBundle(id: string): Promise<SkillRepository> {
  return request("POST", `${repositoryPath(id)}/resume`, { body: {} });
}

export function listRepositorySkills(id: string): Promise<SkillRepositoryView> {
  return request("GET", `${repositoryPath(id)}/skills`);
}

export function importRepositorySkills(
  id: string,
  dirs: string[],
): Promise<SkillRepository> {
  return request("POST", `${repositoryPath(id)}/import`, { body: { dirs } });
}

export function checkSkillRepository(id: string): Promise<SkillRepository> {
  return request("POST", `${repositoryPath(id)}/check`, { body: {} });
}

export function removeSkillRepository(id: string): Promise<void> {
  return request("DELETE", repositoryPath(id));
}

/**
 * Installs a bundle's tool on a device, only on the person's request; with
 * step "setup" runs the tool's setup step there and returns its output.
 */
export function installDeviceTool(
  deviceId: string,
  repositoryId: string,
  tool: string,
  step: "install" | "setup" = "install",
): Promise<{ name: string; version: string; output?: string }> {
  return request(
    "POST",
    `/api/devices/${encodeURIComponent(deviceId)}/tools/install`,
    { body: { repositoryId, tool, step } },
  );
}
