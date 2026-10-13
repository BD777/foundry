// Browser event stream vocabulary (GET /api/events). Every message is an
// envelope `{ type, payload }`; each name and the payload it carries is
// declared here once.
//
// The Go side is apps/server/internal/browserevent. scripts/audit-contract.mjs
// keeps the names, each name's payload type and the payloads' fields of both
// sides in step, and test/browser-event-fixtures.json holds one example of
// each message that both sides' tests read.

import type { WorkspaceFeishuBot } from "./feishu.js";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSubagentDigest,
  ChatLayout,
  ChatQueue,
  ChatThread,
  ChatTitle,
  DeviceProjection,
  FoundryDataProjection,
  Issue,
  RunEvent,
} from "./index.js";

/** The name of every event the stream carries. */
export const browserEventTypes = {
  // Agent sessions. The session events carry the whole session without its
  // transcript, which travels one entry at a time as agent_session_event.
  agentSessionCreated: "agent_session_created",
  agentSessionStarted: "agent_session_started",
  agentSessionBlocked: "agent_session_blocked",
  agentSessionResumed: "agent_session_resumed",
  agentSessionNativeSessionId: "agent_session_native_session_id",
  agentSessionCompleted: "agent_session_completed",
  agentSessionEvent: "agent_session_event",
  agentSubagentUpdated: "agent_subagent_updated",
  backgroundTaskOutputChanged: "background_task_output_changed",
  // Issues and their evidence.
  issueCreated: "issue_created",
  issueUpdated: "issue_updated",
  issueRunEvent: "issue_run_event",
  issueEnvironmentChanged: "issue_environment_changed",
  evidenceUpdated: "evidence_updated",
  // Devices and workspaces.
  deviceStatusChanged: "device_status_changed",
  feishuBotUpdated: "feishu_bot_updated",
  workspaceMembersUpdated: "workspace_members_updated",
  foundryDataChanged: "foundry_data_changed",
  resourcesChanged: "resources_changed",
  // A workspace's chat list.
  chatsChanged: "chats_changed",
  chatQueueChanged: "chat_queue_changed",
  chatTitlesChanged: "chat_titles_changed",
  chatLayoutChanged: "chat_layout_changed",
} as const satisfies Record<string, keyof BrowserEventPayloads>;

export type BrowserEventType =
  (typeof browserEventTypes)[keyof typeof browserEventTypes];

/** The payload each event carries. */
export type BrowserEventPayloads = {
  agent_session_created: AgentSession;
  agent_session_started: AgentSession;
  agent_session_blocked: AgentSession;
  agent_session_resumed: AgentSession;
  agent_session_native_session_id: AgentSession;
  agent_session_completed: AgentSession;
  agent_session_event: AgentSessionEvent;
  agent_subagent_updated: AgentSubagentUpdatedPayload;
  background_task_output_changed: BackgroundTaskOutputChangedPayload;
  issue_created: Issue;
  issue_updated: Issue;
  issue_run_event: RunEvent;
  issue_environment_changed: IssueEnvironmentChangedPayload;
  evidence_updated: EvidenceUpdatedPayload;
  device_status_changed: DeviceStatusChangedPayload;
  feishu_bot_updated: WorkspaceFeishuBot;
  workspace_members_updated: WorkspaceMembersUpdatedPayload;
  foundry_data_changed: FoundryDataChangedPayload;
  resources_changed: ResourcesChangedPayload;
  chats_changed: ChatsChangedPayload;
  chat_queue_changed: ChatQueue;
  chat_titles_changed: ChatTitlesChangedPayload;
  chat_layout_changed: ChatLayoutChangedPayload;
};

/** An event of the stream, of one type (`K`) or of any. */
export type BrowserEvent<
  K extends keyof BrowserEventPayloads = keyof BrowserEventPayloads,
> = {
  [T in K]: { type: T; payload: BrowserEventPayloads[T] };
}[K];

const knownBrowserEventTypes: ReadonlySet<string> = new Set(
  Object.values(browserEventTypes),
);

export function isBrowserEventType(value: string): value is BrowserEventType {
  return knownBrowserEventTypes.has(value);
}

/**
 * Notices: events that change nothing GET /api/foundry-data serves. Each
 * tells the one feature reading the data it names that a read is due, so it
 * reaches only that feature's subscribers. Package browserevent declares
 * the same set (notices); the server's kinds of these keep its snapshots.
 */
export const browserNoticeTypes = [
  browserEventTypes.issueEnvironmentChanged,
  browserEventTypes.backgroundTaskOutputChanged,
  browserEventTypes.resourcesChanged,
] as const satisfies readonly BrowserEventType[];

export type BrowserNoticeType = (typeof browserNoticeTypes)[number];

const knownBrowserNoticeTypes: ReadonlySet<string> = new Set(
  browserNoticeTypes,
);

export function isBrowserNoticeType(
  value: BrowserEventType,
): value is BrowserNoticeType {
  return knownBrowserNoticeTypes.has(value);
}

/**
 * Messages about the stream itself, not about data: where it resumes from,
 * and that events were missed.
 */
export const browserStreamControlTypes = {
  streamReady: "stream_ready",
  resync: "resync",
} as const satisfies Record<string, keyof BrowserStreamControlPayloads>;

export type BrowserStreamControlType =
  (typeof browserStreamControlTypes)[keyof typeof browserStreamControlTypes];

export type BrowserStreamControlPayloads = {
  stream_ready: StreamReadyPayload;
  resync: ResyncPayload;
};

export type BrowserStreamControl<
  K extends keyof BrowserStreamControlPayloads =
    keyof BrowserStreamControlPayloads,
> = {
  [T in K]: { type: T; payload: BrowserStreamControlPayloads[T] };
}[K];

/**
 * One subagent of a session as its list shows it, sent when it starts and
 * when it ends. Without `subagent` the list may have changed in a way the
 * server cannot name: it is read again.
 */
export interface AgentSubagentUpdatedPayload {
  workspaceId: string;
  sessionId: string;
  subagent?: AgentSubagentDigest;
}

/**
 * The log of one of a session's background tasks grew while a reader
 * follows it (GET …/output?follow=1): the reader reads what was added.
 */
export interface BackgroundTaskOutputChangedPayload {
  workspaceId: string;
  sessionId: string;
  taskId: string;
}

/**
 * The device changed what an Issue's environment read returns (its record,
 * its preview); without `issueId`, what every Issue of the workspace reads
 * (its repositories).
 */
export interface IssueEnvironmentChangedPayload {
  workspaceId: string;
  issueId?: string;
}

/** An evidence record of an Issue changed: `entityId` at `version` has `status`. */
export interface EvidenceUpdatedPayload {
  issueId: string;
  workspaceId: string;
  entityId: string;
  version: number;
  status: string;
}

/** A device went online or offline, or changed otherwise. */
export interface DeviceStatusChangedPayload {
  workspaceId: string;
  deviceId: string;
  status: DeviceProjection["status"];
  /**
   * The device as workspace data lists it to a viewer who does not own it
   * (no `owned`, no `runtimeSettings`). Older servers send status only.
   */
  device?: DeviceProjection;
}

/**
 * What GET /api/resources lists changed for a source (a device's report, or
 * it went offline): readers of the resource inventory read it again.
 */
export interface ResourcesChangedPayload {
  sourceId: string;
}

/** Who may use the workspace changed. */
export interface WorkspaceMembersUpdatedPayload {
  workspaceId: string;
}

/** A top-level field of GET /api/foundry-data besides `workspace`. */
export type FoundryDataField =
  | Exclude<keyof FoundryDataProjection, "workspace">
  // The library skills of the workspace, for the composer's menu.
  | "workspaceSkills";

/**
 * Workspace data no other event carries changed: of one workspace, or of
 * every workspace when `workspaceId` is "" (devices, profiles, provider
 * health, skills). Coalesced by the server. `resources` names the fields
 * that changed; without it any may have.
 */
export interface FoundryDataChangedPayload {
  workspaceId: string;
  resources?: FoundryDataField[];
}

/**
 * Chats of the workspace's chat list as it shows them, and the ids of chats
 * it no longer shows.
 */
export interface ChatsChangedPayload {
  workspaceId: string;
  chats: ChatThread[];
  removed: string[];
}

/**
 * Chat titles of the workspace changed: `titles` are the changed chats'
 * entries as GET /api/chat-titles lists them, `removed` the changed chats it
 * no longer lists. Without either, read the list again.
 */
export interface ChatTitlesChangedPayload {
  workspaceId: string;
  titles?: ChatTitle[];
  removed?: string[];
}

/**
 * The workspace's chat groups and order were saved or deleted: `layout` as
 * GET /api/chat-layout answers it (a later revision supersedes it). Without
 * it, read the layout again.
 */
export interface ChatLayoutChangedPayload {
  workspaceId: string;
  layout?: ChatLayout;
}

/** stream_ready says only where the stream resumes from (its id). */
export type StreamReadyPayload = Record<string, never>;

/** Why a stream missed events. */
export type ResyncReason =
  "overflow" | "expired" | "restarted" | "reauthorized";

/** The stream missed events: what was derived from them is read again. */
export interface ResyncPayload {
  reason: ResyncReason;
}
