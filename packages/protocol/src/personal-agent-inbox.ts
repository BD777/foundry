/** A durable, authenticated input. Delivery is not task completion. */
export interface PersonalAgentInboxEntry {
  id: string;
  rootId: string;
  timezone?: string;
  channel: string;
  messageId: string;
  text: string;
  status: string;
  revision: number;
  inputId: string;
  sessionId?: string;
  waitingReason?: string;
  createdAt: string;
  updatedAt: string;
  resultStatus?: string;
  resultText?: string;
  resultError?: string;
  resultTruncated?: boolean;
  /** A failed attempt's error, classified as a failed turn's is. */
  resultFailure?: PersonalAgentInboxFailure;
}

export interface PersonalAgentInboxFailure {
  /**
   * quota_exhausted, rate_limited, provider_unavailable,
   * provider_mismatch, host_stopped or other.
   */
  category: string;
  /** When the provider said it takes requests again. */
  resetAt?: string;
}

export interface PersonalAgentInboxAction {
  action: string;
  revision: number;
  requestId: string;
}

export interface PersonalAgentInboxCapture {
  messageId: string;
  text: string;
}
