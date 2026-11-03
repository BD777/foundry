import {
  sessionEventLabels,
  type AgentSession,
  type Issue,
} from "@bd777/foundry-protocol";
import type { ChatMessageItem } from "../../components/conversation/conversation-types";
import { i18n } from "../../i18n";

/**
 * The Issue's messages and its executions (issue_execution sessions, with
 * their events) in one conversation, without an execution selector.
 */
export function issueTranscript(
  issue: Issue,
  executions: AgentSession[] = [],
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
  const pending = [...(issue.messages ?? [])];
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
    // The Issue tells where its current execution stands first.
    const run =
      issue.run?.id === execution.id
        ? { ...execution, status: issue.run.status, error: issue.run.error }
        : execution;
    // Follow-up inputs have no runId and precede the next execution by timestamp.
    while (
      pending[0] &&
      !pending[0].runId &&
      (!run.startedAt ||
        Date.parse(pending[0].createdAt) <= Date.parse(run.startedAt))
    )
      addMessage(pending.shift()!);
    let response = "";
    let process: NonNullable<ChatMessageItem["processItems"]> = [];
    const flush = () => {
      if (!process.length) return;
      messages.push({
        id: `${run.id}:${process[0]!.id}:process`,
        role: "bot",
        kind: "process",
        text: "",
        processItems: process,
        runtime,
      });
      process = [];
    };
    for (const event of run.events ?? []) {
      if (event.label === sessionEventLabels.issueResponseDelta) {
        response += event.detail;
        continue;
      }
      if (event.label === sessionEventLabels.issueResponseReset) {
        response = event.detail;
        continue;
      }
      if (event.label === sessionEventLabels.steeredIntoTurn) {
        flush();
        messages.push({
          id: event.id,
          role: "user",
          text: event.detail,
          at: event.at,
        });
        continue;
      }
      process.push({
        id: event.id,
        title: event.label,
        detail: event.detail,
        status: event.level === "error" ? "failed" : "completed",
      });
    }
    flush();
    const answers = pending.filter((message) => message.runId === run.id);
    for (const answer of answers) {
      addMessage(answer);
      pending.splice(pending.indexOf(answer), 1);
    }
    if (response && !answers.some((message) => message.role === "assistant"))
      messages.push({
        id: `${run.id}:response`,
        role: "bot",
        text: response,
        streaming: run.status === "running",
        runtime,
      });
    if (run.error)
      messages.push({
        id: `${run.id}:error`,
        role: "bot",
        kind: "failure",
        recoverable: true,
        // Why, what it means and what to do; the raw reason stays last.
        text: i18n.t("issueDetail:transcript.failure", { reason: run.error }),
        title: i18n.t("issueDetail:transcript.failureTitle"),
        runtime,
      });
  }
  pending.forEach(addMessage);
  if (issue.status === "in_progress")
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
