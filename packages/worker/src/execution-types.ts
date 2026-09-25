export interface RegisteredRepository {
  id: string;
  relativePath: string;
  sourcePath: string;
  gitDirectory: string;
  commonDirectory: string;
  kind: "root" | "independent" | "submodule";
  parentId?: string;
  baseline: string;
  status: "ready" | "unborn" | "conflict" | "unavailable";
  error?: string;
}

export interface WorkspaceRegistration {
  content?: {
    tracked: string[];
    untracked: string[];
    ignored: string[];
    truncated: boolean;
  };
  version: 1;
  workspaceId: string;
  sourcePath: string;
  scannedAt: string;
  repositories: RegisteredRepository[];
  errors: string[];
}

export interface CandidateRepository {
  kind: RegisteredRepository["kind"];
  parentId?: string;
  repoId: string;
  relativePath: string;
  sourcePath: string;
  branch: string;
  baseline: string;
  baselineRef: string;
  worktreePath: string;
  status: "preparing" | "ready" | "failed" | "cleaned";
  candidate?: string;
  error?: string;
}

export interface IssueEnvironment {
  contractRevision?: number;
  controlIsolationVersion?: number;
  controlServerURL?: string;
  /**
   * Whether this Issue's processes may read the device owner's own files and
   * credentials. The server decides per run: only for Issues the device
   * owner started. Absent means hidden.
   */
  userFiles?: "readable" | "hidden";
  version: 1;
  id: string;
  workspaceId: string;
  issueId: string;
  sourcePath: string;
  directory: string;
  cwd: string;
  scratch: string;
  revision: number;
  status:
    | "preparing"
    | "ready"
    | "running"
    | "review"
    | "integrated"
    | "abandoned"
    | "failed"
    | "cleanup_pending"
    | "cleaned";
  repositories: CandidateRepository[];
  createdAt: string;
  updatedAt: string;
  nativeSessionId?: string;
  acceptanceId?: string;
  error?: string;
}

export interface AcceptanceRepository {
  relativePath: string;
  repoId: string;
  sourcePath: string;
  worktreePath: string;
  expected: string;
  target: string;
  baselineRef: string;
  status: "prepared" | "applied";
}

export interface WorkspaceAcceptance {
  decisionId?: string;
  reviewSnapshotId?: string;
  candidateSnapshotId?: string;
  integrationSnapshotId?: string;
  finalVerificationIds?: string[];
  version: 1;
  id: string;
  environmentId: string;
  revision: number;
  status: "prepared" | "applying" | "integrated" | "conflict";
  repositories: AcceptanceRepository[];
  createdAt: string;
  error?: string;
}
