/** A project method is snapshotted locally, independently of library publication. */
export interface WorkspaceDraftSkill {
  id: string;
  workspaceId: string;
  executionRootId: string;
  name: string;
  relativePath: string;
  description: string;
  digest?: string;
  status: "ready" | "invalid" | "conflict";
  error?: string;
  /** A verified immutable copy, never the editable source directory. */
  snapshotPath?: string;
  snapshotDigest?: string;
  snapshotRoot?: string;
  entryPath?: string;
  sourceDigest?: string;
  previousDigest?: string;
}

export interface WorkspaceDraftSkills {
  enabled: boolean;
  supported: boolean;
  scannedAt?: string;
  skills: WorkspaceDraftSkill[];
}
