/**
 * Session sources and the classes readers derive from a session's source
 * and status. apps/server/internal/store/session_classes.go mirrors them
 * (SessionSource<Key> is sessionSources.<key>); scripts/audit-contract.mjs
 * pins the two sides.
 */
import type { SessionSource } from "./contract.gen.js";
import type { RunStatus } from "./issue.js";

/** What started a session; a session without one is a chat. */
export const sessionSources = {
  chat: "chat",
  diagnostic: "diagnostic",
  naming: "naming",
  verification: "verification",
  maintenance: "maintenance",
  agent: "agent",
  issue: "issue",
  digest: "digest",
  triage: "triage",
} as const satisfies Record<string, SessionSource>;

export type { SessionSource };
// Every source in the contract (contracts/models/sessions.yaml) has its key.
true satisfies SessionSource extends (typeof sessionSources)[keyof typeof sessionSources]
  ? true
  : never;

/**
 * The statuses of a session still doing work: steer and cancel are legal,
 * it holds an execution slot and the leases and grants of its turn.
 */
export const activeSessionStatuses = [
  "queued",
  "running",
  "blocked",
] as const satisfies readonly RunStatus[];

export type ActiveSessionStatus = (typeof activeSessionStatuses)[number];

export function isActiveSessionStatus(
  status: string | undefined,
): status is ActiveSessionStatus {
  return (activeSessionStatuses as readonly string[]).includes(status ?? "");
}

/**
 * Sessions Foundry starts for itself: read-only, a few turns, no tools
 * beyond reading, no Connectors. A verifier is a role of its own.
 */
export const utilitySessionSources: readonly SessionSource[] = [
  sessionSources.diagnostic,
  sessionSources.naming,
  sessionSources.maintenance,
  sessionSources.digest,
  sessionSources.triage,
];

export function isUtilitySessionSource(source: string | undefined): boolean {
  return utilitySessionSources.includes(source as SessionSource);
}

/**
 * Utility sessions that read only their prompt, which carries all their
 * data: no tools, nothing added to the prompt, and not listed as chats.
 */
export const promptOnlySessionSources: readonly SessionSource[] = [
  sessionSources.naming,
  sessionSources.digest,
  sessionSources.triage,
];

export function isPromptOnlySessionSource(source: string | undefined): boolean {
  return promptOnlySessionSources.includes(source as SessionSource);
}
