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
  inputId: string;
  prompt: string;
  snapshotId?: string;
  status: string;
  reason?: string;
  sessionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
