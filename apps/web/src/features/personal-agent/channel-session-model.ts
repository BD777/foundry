import type {
  MessageChannelDelivery,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";

// Message channels (DEV-203): where a channel's sessions run and how its
// recent messages read by session — the workspace choice, why a session
// started, where a version of AGENTS.md came from.

/** The idle choice as a duration key and count, e.g. 240 → hours 4. */
export function idleLabelParts(minutes: number): {
  unit: "never" | "minutes" | "hours" | "days";
  count: number;
} {
  if (minutes <= 0) return { unit: "never", count: 0 };
  if (minutes % 1440 === 0) return { unit: "days", count: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: "hours", count: minutes / 60 };
  return { unit: "minutes", count: minutes };
}

/**
 * The workspaces a new channel may run in: the person works in them (not
 * only views), they are on the assistant's computer and are not its home
 * or another assistant's, and not archived.
 */
export function channelWorkspaceChoices(
  workspaces: readonly WorkspaceProjection[],
  homeDeviceId: string | undefined,
  homeWorkspaceId: string | undefined,
): WorkspaceProjection[] {
  return workspaces
    .filter(
      (workspace) =>
        Boolean(homeDeviceId) &&
        workspace.deviceId === homeDeviceId &&
        workspace.id !== homeWorkspaceId &&
        workspace.kind !== "personal_agent" &&
        !workspace.archivedAt &&
        workspace.accessRole !== "viewer",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a session started, as the server says it. */
export type NewSessionReason =
  "first" | "idle" | "command" | "button" | "restarted";
const newSessionReasons: readonly NewSessionReason[] = [
  "first",
  "idle",
  "command",
  "button",
  "restarted",
];

export function newSessionReason(
  reason: string | undefined,
): NewSessionReason | undefined {
  return newSessionReasons.find((known) => known === reason);
}

/** Where a saved version of AGENTS.md came from. */
export type RevisionSource = "seed" | "web" | "revert" | "outside";
const revisionSources: readonly RevisionSource[] = [
  "seed",
  "web",
  "revert",
  "outside",
];

/** A revision's source; anything unknown reads as changed elsewhere. */
export function revisionSource(source: string): RevisionSource {
  return revisionSources.find((known) => known === source) ?? "outside";
}

/** The deliveries of one session (or one message outside any), newest first. */
export interface DeliveryGroup {
  key: string;
  sessionId?: string;
  sessionKey?: string;
  deliveries: MessageChannelDelivery[];
  /** Whether a message shown here started the session, and why. */
  started: boolean;
  newReason?: NewSessionReason;
  /** The newest group of its conversation, where "start fresh next time" goes. */
  latest: boolean;
}

function deliveryTime(delivery: MessageChannelDelivery): string {
  return delivery.envelope.occurredAt || delivery.createdAt;
}

function segmentKey(delivery: MessageChannelDelivery): string {
  return `${delivery.sessionKey}#${delivery.segment ?? 0}`;
}

/**
 * Deliveries grouped by session, groups and their messages newest first.
 * A message not delivered yet joins the session of its conversation's
 * segment when one is known, else groups with its segment; a message with
 * no conversation key (e.g. not matched) stands alone.
 */
export function groupDeliveries(
  deliveries: readonly MessageChannelDelivery[],
): DeliveryGroup[] {
  const sorted = [...deliveries].sort((a, b) =>
    deliveryTime(b).localeCompare(deliveryTime(a)),
  );
  const segmentSession = new Map<string, string>();
  for (const delivery of sorted)
    if (delivery.sessionId && delivery.sessionKey)
      segmentSession.set(segmentKey(delivery), delivery.sessionId);
  const groups = new Map<string, DeliveryGroup>();
  const seenConversations = new Set<string>();
  for (const delivery of sorted) {
    const sessionId =
      delivery.sessionId ??
      (delivery.sessionKey
        ? segmentSession.get(segmentKey(delivery))
        : undefined);
    const key = sessionId
      ? `session:${sessionId}`
      : delivery.sessionKey
        ? `segment:${segmentKey(delivery)}`
        : `message:${delivery.id}`;
    let group = groups.get(key);
    if (!group) {
      const conversation = delivery.sessionKey;
      group = {
        key,
        ...(sessionId ? { sessionId } : {}),
        ...(conversation ? { sessionKey: conversation } : {}),
        deliveries: [],
        started: false,
        latest:
          conversation !== undefined && !seenConversations.has(conversation),
      };
      if (conversation) seenConversations.add(conversation);
      groups.set(key, group);
    }
    group.deliveries.push(delivery);
    if (delivery.sessionNew) {
      group.started = true;
      const reason = newSessionReason(delivery.newReason);
      if (reason) group.newReason = reason;
    }
  }
  return [...groups.values()];
}
