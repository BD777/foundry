import type {
  AgentSession,
  AgentSessionEvent,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import type {
  DeviceStatusChangedPayload,
  FoundryData,
  FoundryDataField,
  FoundryStreamEvent,
} from "../api-types";
import {
  applyIssueStreamEvent,
  mergeIssue,
  mergeIssueRun,
} from "./issue-data-projection";
import {
  isMatchingResponseStreamEvent,
  mergeLoadedAgentSession,
} from "../lib/agent-session-events";
import { appendAgentEvents } from "../lib/agent-event-log";
import type { StreamTouches } from "./stream-touches";

function upsertStreamedAgentSession(
  sessions: AgentSession[],
  incoming: AgentSession,
): AgentSession[] {
  const index = sessions.findIndex((session) => session.id === incoming.id);
  if (index < 0) {
    return [mergeLoadedAgentSession(undefined, incoming), ...sessions];
  }
  const next = [...sessions];
  next[index] = mergeLoadedAgentSession(sessions[index], incoming);
  return next;
}

/**
 * Keeps what live events changed after a read started: the read may have
 * been served before them. `keep` entities stay as shown; one live events
 * touched (`live`) that the read does not list yet stays in front, as the
 * stream added it. The rest come back as the read has them, in its order.
 */
function keepStreamed<T extends { id: string }>(
  current: readonly T[],
  merged: T[],
  keep: ReadonlySet<string> = new Set(),
  live: ReadonlySet<string> = keep,
): T[] {
  if (keep.size === 0 && live.size === 0) return merged;
  const shown = new Map(current.map((item) => [item.id, item]));
  const result = merged.map((item) =>
    keep.has(item.id) ? (shown.get(item.id) ?? item) : item,
  );
  const listed = new Set(merged.map((item) => item.id));
  const added = current.filter(
    (item) => live.has(item.id) && !listed.has(item.id),
  );
  return added.length > 0 ? [...added, ...result] : result;
}

// Every field of workspace data besides the workspace; the record makes
// the list complete.
const fieldFlags: Record<FoundryDataField, true> = {
  runs: true,
  agentProfiles: true,
  agents: true,
  agentSessions: true,
  assets: true,
  chats: true,
  deviceProfiles: true,
  deviceSkillRoots: true,
  devices: true,
  issues: true,
  profiles: true,
  promotedSkills: true,
  builtinSkills: true,
  providerHealth: true,
  skills: true,
  workspaceFiles: true,
  workspaceSkillBindings: true,
  defaultSkillIds: true,
  inheritedSkillIds: true,
  offSkillIds: true,
  deviceTools: true,
  skillBundles: true,
  workspaceBundleIds: true,
  defaultBundleIds: true,
  workspaces: true,
  workspaceSkills: true,
};
export const foundryDataFields = Object.keys(fieldFlags) as FoundryDataField[];

/**
 * Fields a read without a selection leaves out: the skill library's
 * catalog, which the pages showing it read themselves, and skills, which
 * nothing shows. They are not tied to a workspace.
 */
export const foundryDataPageFields: readonly FoundryDataField[] = [
  "promotedSkills",
  "skills",
];

/**
 * Like keepStreamed for a list the stream also removes from: a chat the
 * stream sent or removed after the read started stays as shown, present or
 * not.
 */
function keepStreamedChats<T extends { id: string }>(
  current: readonly T[],
  loaded: T[],
  touched: ReadonlySet<string> = new Set(),
): T[] {
  if (touched.size === 0) return loaded;
  const shown = new Map(current.map((item) => [item.id, item]));
  const result = loaded.flatMap((item) => {
    if (!touched.has(item.id)) return [item];
    const kept = shown.get(item.id);
    return kept ? [kept] : [];
  });
  const listed = new Set(loaded.map((item) => item.id));
  const added = current.filter(
    (item) => touched.has(item.id) && !listed.has(item.id),
  );
  return added.length > 0 ? [...added, ...result] : result;
}

/** What a selection read changes: its fields; one it lacks is empty. */
function selectedFields(
  current: FoundryData,
  loaded: FoundryData,
  fields: readonly FoundryDataField[],
): FoundryData {
  const merged: Record<string, unknown> = {
    ...current,
    workspace: loaded.workspace,
  };
  for (const field of fields) {
    if (loaded[field] === undefined) delete merged[field];
    else merged[field] = loaded[field];
  }
  return merged as unknown as FoundryData;
}

/** A whole read keeps the pages' own fields, which it leaves out. */
function withPageFields(
  loaded: FoundryData,
  current: FoundryData,
): FoundryData {
  const kept = foundryDataPageFields.filter(
    (field) => loaded[field] === undefined && current[field] !== undefined,
  );
  if (kept.length === 0) return loaded;
  const merged: Record<string, unknown> = { ...loaded };
  for (const field of kept) merged[field] = current[field];
  return merged as unknown as FoundryData;
}

/**
 * Preserve richer streamed session state when a list refresh completes.
 * `touched` names what live events changed after the refresh started: a
 * device, issue or session they replaced stays as shown (it is at least as
 * new as the read); a session that only received transcript events takes
 * the read's summary but does not go back from running to queued; a chat
 * they sent or removed stays as shown.
 *
 * `fields` names what the read selected: only those change (a field the
 * answer leaves out is empty). Without it the read answered every field but
 * the pages' own, which stay as they are.
 */
export function mergeLoadedFoundryData(
  current: FoundryData,
  loaded: FoundryData,
  touched?: StreamTouches,
  fields?: readonly FoundryDataField[],
): FoundryData {
  if (current === loaded) {
    return current;
  }
  const read = (field: FoundryDataField) =>
    fields ? fields.includes(field) : !foundryDataPageFields.includes(field);
  const answered = fields
    ? selectedFields(current, loaded, fields)
    : withPageFields(loaded, current);
  if (current.workspace.id !== loaded.workspace.id) {
    // Another workspace: nothing shown is newer than the read. A selection
    // cannot switch workspaces.
    return fields ? current : answered;
  }
  // The read may be the cached answer of a later 304: never change it.
  const merged: FoundryData = { ...answered };
  if (read("devices"))
    merged.devices = keepStreamed(
      current.devices,
      loaded.devices,
      touched?.devices,
    );
  if (read("issues"))
    merged.issues = keepStreamed(
      current.issues,
      loaded.issues.map((issue) =>
        mergeIssue(
          current.issues.find((item) => item.id === issue.id),
          issue,
        ),
      ),
      touched?.issues,
    );
  if (read("runs"))
    merged.runs = loaded.runs?.map((run) =>
      mergeIssueRun(
        current.runs?.find((item) => item.id === run.id),
        run,
      ),
    );
  if (read("chats"))
    merged.chats = keepStreamedChats(
      current.chats,
      loaded.chats,
      touched?.chats,
    );
  if (read("agentSessions")) {
    const existingSessions = new Map(
      current.agentSessions.map((session) => [session.id, session]),
    );
    const streamedSessions = new Set([
      ...(touched?.sessions ?? []),
      ...(touched?.sessionEvents ?? []),
    ]);
    merged.agentSessions = keepStreamed(
      current.agentSessions,
      loaded.agentSessions.map((session) => {
        const existing = existingSessions.get(session.id);
        const merged = mergeLoadedAgentSession(existing, session);
        // A live event started it after the read began: still running.
        return touched?.sessionEvents.has(session.id) &&
          existing?.status === "running" &&
          merged.status === "queued"
          ? {
              ...merged,
              status: existing.status,
              updatedLabel: existing.updatedLabel,
            }
          : merged;
      }),
      touched?.sessions,
      streamedSessions,
    );
  }
  return merged;
}

/** A chats_changed event applied to the chat list. */
function applyChatChanges(
  chats: FoundryData["chats"],
  {
    chats: changed,
    removed,
  }: { chats: FoundryData["chats"]; removed: string[] },
): FoundryData["chats"] {
  const gone = new Set(removed);
  const incoming = new Map(changed.map((chat) => [chat.id, chat]));
  const next = chats
    .filter((chat) => !gone.has(chat.id))
    .map((chat) => {
      const replaced = incoming.get(chat.id);
      if (replaced) incoming.delete(chat.id);
      return replaced ?? chat;
    });
  return incoming.size > 0 ? [...incoming.values(), ...next] : next;
}

/**
 * Keep transport bursts cheap without changing the semantic event order.
 * Consecutive response snapshots describe the same growing message, so only
 * the newest snapshot in that run needs to reach React.
 */
export function compactFoundryStreamEvents(
  events: FoundryStreamEvent[],
): FoundryStreamEvent[] {
  const compacted: FoundryStreamEvent[] = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    if (
      event.type === "agent_session_event" &&
      event.payload.label === "Response stream" &&
      previous?.type === "agent_session_event" &&
      previous.payload.label === "Response stream" &&
      previous.payload.sessionId === event.payload.sessionId &&
      isMatchingResponseStreamEvent(previous.payload, event.payload)
    ) {
      compacted[compacted.length - 1] = event;
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

/**
 * The whole device a status event carries (newer servers), as workspace
 * data lists it to a viewer who does not own it. Undefined for status only.
 */
export function streamedDevice(
  payload: DeviceStatusChangedPayload,
): DeviceProjection | undefined {
  return payload.device?.id === payload.deviceId ? payload.device : undefined;
}

/** Apply a daemon stream event to the shared application projection. */
export function applyFoundryStreamEvent(
  current: FoundryData,
  streamEvent: FoundryStreamEvent,
): FoundryData {
  if (streamEvent.type === "evidence_updated") return current;
  if (streamEvent.type === "device_status_changed") {
    const { deviceId, status } = streamEvent.payload;
    if (!current.devices.some((device) => device.id === deviceId))
      return current;
    const streamed = streamedDevice(streamEvent.payload);
    return {
      ...current,
      devices: current.devices.map((device) => {
        if (device.id !== deviceId) return device;
        if (!streamed) {
          return {
            ...device,
            status,
            lastSeenLabel: status === "connected" ? "online" : "offline",
          };
        }
        // What only its owner sees and whether this viewer owns it stay
        // this viewer's own: the shared event leaves them out.
        const {
          owned: _owned,
          runtimeSettings: _runtimeSettings,
          ...shared
        } = streamed;
        return {
          ...shared,
          ...(device.owned === undefined ? {} : { owned: device.owned }),
          ...(device.runtimeSettings === undefined
            ? {}
            : { runtimeSettings: device.runtimeSettings }),
        };
      }),
    };
  }
  if (
    streamEvent.type === "issue_created" ||
    streamEvent.type === "issue_updated" ||
    streamEvent.type === "issue_run_event"
  )
    return applyIssueStreamEvent(current, streamEvent);
  if (streamEvent.type === "chats_changed") {
    if (streamEvent.payload.workspaceId !== current.workspace.id)
      return current;
    return {
      ...current,
      chats: applyChatChanges(current.chats, streamEvent.payload),
    };
  }
  // Feature-owned events: their features subscribe to them directly.
  if (
    streamEvent.type === "feishu_bot_updated" ||
    streamEvent.type === "workspace_members_updated" ||
    streamEvent.type === "chat_queue_changed" ||
    streamEvent.type === "agent_subagent_updated" ||
    streamEvent.type === "chat_titles_changed" ||
    streamEvent.type === "chat_layout_changed" ||
    // Says only that a read is due; the live-data layer reads.
    streamEvent.type === "foundry_data_changed"
  ) {
    return current;
  }
  if (streamEvent.type !== "agent_session_event") {
    if (streamEvent.payload.workspaceId !== current.workspace.id) {
      return current;
    }
    return {
      ...current,
      agentSessions: upsertStreamedAgentSession(
        current.agentSessions,
        streamEvent.payload,
      ),
    };
  }

  return applyAgentSessionEvents(current, [streamEvent.payload]);
}

/**
 * Adds live events to their sessions: one copy of each session's event list
 * per call, however many of its events arrived.
 */
function applyAgentSessionEvents(
  current: FoundryData,
  events: readonly AgentSessionEvent[],
): FoundryData {
  const bySession = new Map<string, AgentSessionEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId);
    if (list) list.push(event);
    else bySession.set(event.sessionId, [event]);
  }
  let agentSessions: AgentSession[] | undefined;
  current.agentSessions.forEach((session, index) => {
    const incoming = bySession.get(session.id);
    if (!incoming) return;
    agentSessions ??= [...current.agentSessions];
    agentSessions[index] = {
      ...session,
      events: appendAgentEvents(session.events, incoming),
      status: session.status === "queued" ? "running" : session.status,
      updatedLabel:
        session.status === "queued" || session.status === "running"
          ? "running"
          : session.updatedLabel,
    };
  });
  return agentSessions ? { ...current, agentSessions } : current;
}

/**
 * Applies one frame's stream events in order. Consecutive session events are
 * merged per session in one step instead of one copy per event.
 */
export function applyFoundryStreamEvents(
  current: FoundryData,
  streamEvents: readonly FoundryStreamEvent[],
): FoundryData {
  let next = current;
  let run: AgentSessionEvent[] = [];
  const flush = () => {
    if (run.length > 0) next = applyAgentSessionEvents(next, run);
    run = [];
  };
  for (const streamEvent of streamEvents) {
    if (streamEvent.type === "agent_session_event") {
      run.push(streamEvent.payload);
      continue;
    }
    flush();
    next = applyFoundryStreamEvent(next, streamEvent);
  }
  flush();
  return next;
}
