import type { AgentSession, Issue } from "@bd777/foundry-protocol";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import { isSessionLive } from "../../lib/session-status";
import { i18n } from "../../i18n";

/** How a host shows sessions' transcripts: as a chat does (the app passes it). */
export type ExecutionTranscript = (
  executions: AgentSession[],
) => ChatMessageItem[];

/**
 * The Issue's messages and its executions in one conversation. Each
 * execution is a session and shows as a chat shows it; around them are the
 * Issue's own messages: the request, the person's follow-ups and what an
 * execution asked them.
 */
export function issueTranscript(
  issue: Issue,
  executions: AgentSession[],
  executionTranscript: ExecutionTranscript,
): ChatMessageItem[] {
  const runtime = issue.runtime === "mock" ? undefined : issue.runtime;
  const messages: ChatMessageItem[] = [
    {
      id: `${issue.id}:source`,
      role: "user",
      text: issue.sourceInput,
      copyText: issue.sourceInput,
    },
  ];
  const ordered = executions
    .filter((execution) => execution.issueId === issue.id)
    .sort(
      (a, b) =>
        (Date.parse(a.startedAt ?? "") || 0) -
        (Date.parse(b.startedAt ?? "") || 0),
    );
  const shown = new Set(ordered.map((execution) => execution.id));
  // The Issue keeps an execution's answer as msg_<its session id>
  // (sqlitestore/daemon.go) for its other readers; the session shows it.
  const pending = (issue.messages ?? []).filter(
    (message) =>
      !(
        message.runId &&
        shown.has(message.runId) &&
        message.id === `msg_${message.runId}`
      ),
  );
  // Initial clarification repeats the source in the transport for idempotency,
  // but it is still the user's first message, not a second bubble.
  if (
    pending[0]?.id.startsWith("clarify_") &&
    pending[0].role === "user" &&
    pending[0].text === issue.sourceInput
  )
    pending.shift();
  const addMessage = (message: NonNullable<Issue["messages"]>[number]) => {
    messages.push({
      id: message.id,
      role: message.role === "user" ? "user" : "bot",
      text: message.text,
      at: message.createdAt,
      runtime,
      copyText: message.text,
      origin:
        message.via === "feishu"
          ? i18n.t("issueDetail:transcript.viaFeishu")
          : undefined,
    });
  };
  for (const execution of ordered) {
    // Follow-up inputs have no runId and precede the next execution by timestamp.
    while (
      pending[0] &&
      !pending[0].runId &&
      (!execution.startedAt ||
        Date.parse(pending[0].createdAt) <= Date.parse(execution.startedAt))
    )
      addMessage(pending.shift()!);
    messages.push(...executionTranscript([execution]));
    for (const asked of pending.filter((m) => m.runId === execution.id)) {
      addMessage(asked);
      pending.splice(pending.indexOf(asked), 1);
    }
  }
  pending.forEach(addMessage);
  // Claimed, before its execution is read: the Issue says it works.
  if (issue.status === "in_progress" && !ordered.some(isSessionLive))
    messages.push({
      id: `${issue.id}:working`,
      role: "bot",
      kind: "process",
      text: "",
      title: i18n.t("issueDetail:transcript.working"),
      streaming: true,
      runtime,
    });
  return messages;
}
