// Workspaces and the files and folders of their device folder.
import type {
  WorkspaceNativeSessionsMoved,
  WorkspaceProjection,
} from "./contract.gen.js";
export type {
  AssetProjection,
  WorkspaceAccessRole,
  WorkspaceDirectoryEntry,
  WorkspaceFileEntry,
  WorkspaceKind,
  WorkspaceNativeSessionsMoved,
  WorkspaceProjection,
  WorkspaceRelinkSuggestion,
  WorkspaceTreeEntry,
  WorkspaceUnavailability,
} from "./contract.gen.js";

/** The answer to locating a workspace's folder. */
export interface WorkspaceRelinkResult {
  workspace: WorkspaceProjection;
  nativeSessions: WorkspaceNativeSessionsMoved;
}

export interface WorkspaceFileRead {
  workspaceId: string;
  path: string;
  content: string;
  truncated: boolean;
  /**
   * Where the file really is, relative to the workspace, when `path` reaches
   * it through a link inside the workspace.
   */
  realPath?: string;
  /** A file of a skill Foundry linked in from its snapshots: shown, never changed. */
  readOnly?: boolean;
}
