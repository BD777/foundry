export interface PersonalAgentRunPreference {
  deviceId?: string;
  profileId?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  disabled?: boolean;
  tokenBudget?: number;
  timeoutMinutes?: number;
  fallbacks?: PersonalAgentRunTarget[];
}

export interface PersonalAgentRunTarget {
  deviceId: string;
  profileId: string;
  runtime: string;
  model?: string;
  effort?: string;
  workspaceIds: string[];
}

export interface PersonalAgentRunSnapshot {
  /** Cached native account description, not online authentication proof. */
  accountLabel?: string;
  inputId: string;
  id: string;
  role: string;
  workspaceId: string;
  deviceId: string;
  runtime: string;
  profileId: string;
  agentId?: string;
  model?: string;
  effort?: string;
  profileFingerprint?: string;
  providerOrigin?: string;
  providerConfigHash?: string;
  configHash: string;
  tokenBudget: number;
  timeoutMinutes: number;
  selectionReason: string;
  createdAt: string;
  sessionId?: string;
}

export interface PersonalAgentRunPreview {
  role: string;
  workspaceId: string;
}

export interface PersonalAgentRunControl {
  nativeEndedAt?: string;
  nativeStatus?: string;
  waitingReason?: string;
  dispatchAttempted: boolean;
  id: string;
  snapshotId?: string;
  sessionId: string;
  inputId: string;
  role: string;
  state: string;
  stopReason?: string;
  observedTokens: number;
  usageState: string;
  tokenBudget: number;
  timeoutMinutes: number;
  lastUsageAt?: string;
  confirmedAt?: string;
  revision: number;
  updatedAt: string;
}
