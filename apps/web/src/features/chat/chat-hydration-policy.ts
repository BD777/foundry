/**
 * Pure decisions about which chat hydration requests a selection still needs.
 * Keeping them out of the effects makes the latest-wins lifecycle testable
 * without a React renderer.
 */

export interface ChatDetailHydrationInput {
  /** Chat id whose full detail is already in feature state. */
  hydratedChatId?: string;
  selectedSummary?: { handoffContext?: unknown; id: string };
  /** A live thread already carries the transcript the detail would supply. */
  threadSelected: boolean;
}

/** Chat id that still needs a detail fetch, or `undefined` when none does. */
export function chatDetailHydrationId({
  hydratedChatId,
  selectedSummary,
  threadSelected,
}: ChatDetailHydrationInput): string | undefined {
  if (!selectedSummary) {
    return undefined;
  }
  if (selectedSummary.handoffContext || threadSelected) {
    return undefined;
  }
  return hydratedChatId === selectedSummary.id ? undefined : selectedSummary.id;
}

/** Sessions whose runtime can report subagents worth discovering. */
interface SubagentDiscoverySession {
  events?: readonly {
    id: string;
    label: string;
    metadata?: { taskId?: string };
  }[];
  id: string;
  provider: string;
  status?: string;
}

function hasSubagentLifecycle(session: SubagentDiscoverySession): boolean {
  return (session.events ?? []).some(
    (event) =>
      Boolean(event.metadata?.taskId) ||
      /^(?:正在启动子任务|子任务进行中|子任务完成|子任务失败|Starting subtask|Subtask )/i.test(
        event.label,
      ),
  );
}

export function subagentDiscoverySessionIds(
  sessions: readonly SubagentDiscoverySession[],
): string[] {
  return sessions
    .filter(
      (session) =>
        session.provider === "claude" &&
        (session.status === "running" || hasSubagentLifecycle(session)),
    )
    .map((session) => session.id);
}

/** Changes only when subagent-relevant state changes, not for every token. */
export function subagentDiscoveryRevision(
  sessions: readonly SubagentDiscoverySession[],
): string {
  return sessions
    .filter((session) => session.provider === "claude")
    .map((session) => {
      const taskEvents = (session.events ?? [])
        .filter(
          (event) =>
            Boolean(event.metadata?.taskId) ||
            /^(?:正在启动子任务|子任务进行中|子任务完成|子任务失败|Starting subtask|Subtask )/i.test(
              event.label,
            ),
        )
        .map((event) => event.id)
        .join(",");
      return `${session.id}:${session.status ?? ""}:${taskEvents}`;
    })
    .join("|");
}

/**
 * A value-stable dependency for selected-thread transcript hydration.
 *
 * Session projection objects are replaced by background list refreshes even
 * when the sessions that need detail did not change. Depending on those
 * objects directly aborts otherwise healthy detail requests.
 */
export function sessionThreadHydrationId(
  threadId: string | undefined,
  missingSessionIds: readonly string[],
): string | undefined {
  return threadId && missingSessionIds.length > 0 ? threadId : undefined;
}

export function sessionThreadHydrationRevision(
  threadId: string | undefined,
  sessions: readonly {
    events?: readonly { at: string; id: string }[];
    id: string;
    lastActivityAt?: string;
  }[],
): string | undefined {
  if (!threadId || sessions.length === 0) {
    return undefined;
  }
  return [
    threadId,
    ...sessions.map((session) => {
      const latest = session.events?.[session.events.length - 1];
      return `${session.id}:${session.lastActivityAt ?? ""}:${latest?.id ?? ""}:${latest?.at ?? ""}`;
    }),
  ].join("|");
}
