/** Durable instruction and receipt; live execution state belongs to the session. */
export interface PersonalAgentOperation {
  id: string;
  itemId: string;
  intentRevision: number;
  stepKey: string;
  workspaceId: string;
  sourceSessionId: string;
  sourceInputId?: string;
  targetSessionId?: string;
  replaceOwner?: boolean;
  /** The execution model choice the helper was started with (DEV-188). */
  executionChoice?: string;
  /** Dispatched as changing nothing: it does not wait for the workspace's writer (DEV-229). */
  readOnly?: boolean;
  inputId: string;
  prompt: string;
  snapshotId?: string;
  status: string;
  reason?: string;
  sessionId?: string;
  /** While a write step waits for its workspace's writer (DEV-229). */
  waitingSince?: string;
  busySessionId?: string;
  busySince?: string;
  queuedNoticeAt?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
