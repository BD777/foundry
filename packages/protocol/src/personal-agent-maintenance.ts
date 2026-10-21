export interface MaintenanceFinding {
  kind: string;
  summary: string;
  sourceRefs: string[];
}
export interface MaintenancePatch {
  path: string;
  baseHash: string;
  content: string;
  reason: string;
}
export interface MaintenanceResult {
  summary: string;
  findings: MaintenanceFinding[];
  patches: MaintenancePatch[];
}
export interface PersonalAgentMaintenance {
  id: string;
  role: string;
  workspaceId: string;
  vaultId?: string;
  eventKey: string;
  status: string;
  reason?: string;
  revision: number;
  attempt: number;
  sessionId?: string;
  inputId?: string;
  snapshotId?: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  result?: MaintenanceResult;
}
export interface ContextPatchCommand {
  workspaceId: string;
  operationId: string;
  action: "read" | "apply";
  path: string;
  baseHash: string;
  content: string;
}
export interface ContextPatchReply {
  operationId: string;
  path: string;
  hash: string;
  content?: string;
  state: string;
  error?: string;
  code?: string;
}
export interface PersonalAgentContextPatch {
  id: string;
  jobId: string;
  workspaceId: string;
  deviceId: string;
  index: number;
  path: string;
  baseHash: string;
  hash: string;
  status: string;
  reason?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
