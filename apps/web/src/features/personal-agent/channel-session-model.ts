import type { WorkspaceProjection } from "@bd777/foundry-protocol";

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
  "first" | "idle" | "command" | "button" | "restarted" | "ended";
const newSessionReasons: readonly NewSessionReason[] = [
  "first",
  "idle",
  "command",
  "button",
  "restarted",
  "ended",
];

export function newSessionReason(
  reason: string | undefined,
): NewSessionReason | undefined {
  return newSessionReasons.find((known) => known === reason);
}

/** Where a saved version of a workspace file came from (DEV-223). */
export type RevisionSource =
  "seed" | "web" | "revert" | "outside" | "default" | "deleted" | "renamed";
const revisionSources: readonly RevisionSource[] = [
  "seed",
  "web",
  "revert",
  "outside",
  "default",
  "deleted",
  "renamed",
];

/** A revision's source; anything unknown reads as changed elsewhere. */
export function revisionSource(source: string): RevisionSource {
  return revisionSources.find((known) => known === source) ?? "outside";
}
