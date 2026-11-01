// Workspaces and the files and folders of their device folder.

export interface WorkspaceProjection {
  id: string;
  name: string;
  localPath: string;
  baseline: string;
  contextSummary: string;
  acceptedCount: number;
  resolvedCount: number;
  deviceId?: string;
  deviceLabel?: string;
  /** The caller's role in this workspace. */
  accessRole?: WorkspaceAccessRole;
  /**
   * Set while its device, connected, does not serve the folder. Sessions and
   * history stay; adding the folder on the device again clears it.
   */
  unavailableOnDevice?: WorkspaceUnavailability;
  /** Absent means "project". */
  kind?: WorkspaceKind;
  /**
   * Set while archived: hidden in an "Archived" group, starts no sessions,
   * everything kept. Restoring clears it.
   */
  archivedAt?: string;
}

/** Every workspace is a project except each person's Personal Agent Workspace. */
export type WorkspaceKind = "project" | "personal_agent";

/** Why a workspace cannot run on its device. */
export interface WorkspaceUnavailability {
  /**
   * "not_served": the device's worker no longer lists the folder.
   * "folder_missing": the worker still has the workspace, but its folder
   * (the workspace's localPath, its last known path) is gone from the
   * device: moved, renamed or deleted.
   */
  reason: "not_served" | "folder_missing";
  since: string;
}

/** A folder on the device that looks like a missing workspace's, moved. */
export interface WorkspaceRelinkSuggestion {
  path: string;
  /**
   * "same_workspace": the folder holds this workspace's own Foundry identity
   * (.foundry/workspace.json), so it is the folder, moved or renamed.
   * "same_git_remote": its Git repository has the same origin remote.
   */
  reason: "same_workspace" | "same_git_remote";
}

/** What moving a workspace's native chats to its new folder did. */
export interface WorkspaceNativeSessionsMoved {
  /** Native sessions now resumable in the new folder (copied there). */
  copied: number;
  /** Already resumable there (nothing to do, e.g. Codex, keyed by id). */
  alreadyThere: number;
  /**
   * Not found on the device: their chats continue in a new native session
   * that is given the Foundry conversation.
   */
  notFound: number;
}

/** The answer to locating a workspace's folder. */
export interface WorkspaceRelinkResult {
  workspace: WorkspaceProjection;
  nativeSessions: WorkspaceNativeSessionsMoved;
}

export type WorkspaceAccessRole = "viewer" | "member" | "maintainer" | "owner";

export interface WorkspaceFileEntry {
  /** Device content identity for bounded instruction files. */
  revision?: string;
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeLabel: string;
  updatedLabel: string;
}

export interface WorkspaceFileRead {
  workspaceId: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceDirectoryEntry {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceTreeEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  extension?: string;
}

export interface AssetProjection {
  id: string;
  workspaceId?: string;
  name: string;
  kind:
    "worktree_pool" | "preview_ports" | "artifact_archive" | "provider_auth";
  status: "available" | "leased" | "missing" | "blocked";
  detail: string;
}
