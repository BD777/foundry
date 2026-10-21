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
