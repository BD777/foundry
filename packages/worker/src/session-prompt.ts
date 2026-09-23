// Session prompt assembly. A leaf module: it depends only on protocol types
// and profile/utility helpers, so both the runner and the launch-policy layer
// can import it without a cycle.

import type { AgentSession } from "@foundry/protocol";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { sessionAttachmentContext } from "./profiles.js";
import { isUtilitySession } from "./utils.js";

export function sessionPrompt(
  session: AgentSession,
  profile?: AgentProfileLocalConfig,
): string {
  if (session.source === "naming") return session.prompt.trim();
  const importedContext = !isUtilitySession(session)
    ? session.importedContext?.trim()
    : "";
  const attachmentContext = !isUtilitySession(session)
    ? sessionAttachmentContext(session)
    : "";
  const prompt = [
    importedContext
      ? `Context imported from the same Foundry chat before this turn:\n\n${importedContext}`
      : "",
    attachmentContext,
    session.prompt.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (isUtilitySession(session)) {
    return `${prompt}

You are running through Foundry's local daemon. Treat the workspace as read-only for this diagnostic session. Read files if needed, but do not edit, create, delete, or move files. Return a concise answer.`;
  }
  return prompt;
}
