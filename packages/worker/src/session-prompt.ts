// Session prompt assembly. A leaf module: it depends only on protocol types
// and profile/utility helpers, so both the runner and the launch-policy layer
// can import it without a cycle.

import type {
  AgentSession,
  ChatAttachment,
  SessionInput,
} from "@bd777/foundry-protocol";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { isUtilitySession } from "./utils.js";

/**
 * The input this dispatch runs. Sessions built inside the worker (Issue
 * execution, evidence) carry no input; their prompt is the input.
 */
export function currentInput(session: AgentSession): SessionInput {
  return session.input ?? { id: session.id, prompt: session.prompt };
}

export function sessionPrompt(
  session: AgentSession,
  profile?: AgentProfileLocalConfig,
): string {
  const input = currentInput(session);
  if (session.source === "naming") return input.prompt.trim();
  const importedContext = !isUtilitySession(session)
    ? input.importedContext?.trim()
    : "";
  const prompt = [
    importedContext
      ? `Context imported from the same Foundry chat before this turn:\n\n${importedContext}`
      : "",
    isUtilitySession(session)
      ? input.prompt.trim()
      : userMessageText(input.prompt, input.attachments),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (isUtilitySession(session)) {
    return `${prompt}

You are running through Foundry's local daemon. Treat the workspace as read-only for this diagnostic session. Read files if needed, but do not edit, create, delete, or move files. Return a concise answer.`;
  }
  return prompt;
}

/**
 * A person's message as the agent reads it: the files that came with it, then
 * its text. Every way a message reaches an agent (a turn's input, a steer into
 * a running turn) goes through here, so attachments arrive the same way.
 */
export function userMessageText(
  text: string,
  attachments: ChatAttachment[] = [],
): string {
  return [attachmentContext(attachments), text.trim()]
    .filter(Boolean)
    .join("\n\n");
}

function attachmentContext(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const lines = attachments.map((attachment, index) => {
    const label = attachment.kind === "image" ? "image" : "file";
    const mime = attachment.mimeType ? ` (${attachment.mimeType})` : "";
    const path = attachment.path.trim();
    const tag =
      attachment.kind === "image"
        ? `\n<image name="${attachment.name}" path="${path}"></image>`
        : "";
    return `${index + 1}. ${label}: ${attachment.name}${mime}\n   path: ${path}${tag}`;
  });
  return [
    "Attached files for this turn are available on the local filesystem. Use the paths below as the source of truth.",
    ...lines,
  ].join("\n");
}
