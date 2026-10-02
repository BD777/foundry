import type { Issue } from "@bd777/foundry-protocol";

/**
 * Confirmation ends clarification. Only post-confirmation execution feedback
 * can guide a run; an answer to the execution's question comes with it.
 */
export function executionFeedback(issue: Issue): string[] {
  const confirmedAt = Date.parse(
    issue.executionContract?.confirmation?.at ?? "",
  );
  const asked = new Map(
    (issue.messages ?? []).map((message) => [message.id, message.text]),
  );
  return (issue.messages ?? [])
    .filter(
      (message) =>
        message.role === "user" &&
        !message.id.startsWith("clarify_") &&
        !message.id.startsWith("status_question_") &&
        Number.isFinite(confirmedAt) &&
        Date.parse(message.createdAt) >= confirmedAt,
    )
    .slice(-12)
    .map((message) => {
      const question = message.id.endsWith("_answer")
        ? asked.get(message.id.slice(0, -"_answer".length))
        : undefined;
      return question
        ? `Your question: ${question}\nThe person's answer: ${message.text}`
        : message.text;
    });
}

export function confirmedExecutionPrompt(issue: Issue): string {
  return `The user explicitly confirmed the following exact acceptance contract and authorized implementation in the candidate workspace. Clarification has ended. Implement the agreed deliverable now; do not ask for the same confirmation again. The original request and pre-confirmation conversation are historical context, not current execution instructions. Communicate with the user in the same language as the confirmed goal, while preserving exact required deliverable text.

Human-confirmed acceptance contract (authoritative; you cannot confirm or change it):
${JSON.stringify(issue.executionContract)}`;
}
