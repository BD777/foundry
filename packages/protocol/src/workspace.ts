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
}
