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
  lastTrial?: DraftSkillTrial;
}

export interface WorkspaceDraftSkills {
  enabled: boolean;
  supported: boolean;
  scannedAt?: string;
  skills: WorkspaceDraftSkill[];
}

/** Explicit trials always start with clean native history and locked inputs. */
export interface SkillSelection {
  mode: "include" | "exclude";
  drafts?: DraftSelectionRef[];
  names?: string[];
  library?: LibrarySelectionRef[];
}
export interface ResolvedSkillSelection {
  mode: "include" | "exclude";
  drafts: WorkspaceDraftSkill[];
  libraryRefs: import("./skills.js").SessionSkillRef[];
  excludedNames: string[];
  transfers?: DraftSkillTransfer[];
}

export interface DraftSelectionRef {
  id: string;
  digest: string;
}
export interface LibrarySelectionRef {
  skillId: string;
  revision: number;
}
export interface DraftSkillTransfer {
  id: string;
  digest: string;
  archiveBase64: string;
  checksum: string;
}

export interface DraftSkillTrial {
  sessionId: string;
  digest: string;
  status: string;
}
