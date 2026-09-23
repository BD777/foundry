import type { AgentSubagentTranscript } from "@foundry/protocol";
import type { ChatMessageItem } from "./chat-surface-types";
import { subagentTranscriptEntries } from "./transcript-adapters";
import { projectTranscript } from "./transcript-projection";

export function chatMessagesForSubagentTranscript(
  transcript: AgentSubagentTranscript,
): ChatMessageItem[] {
  const messages = projectTranscript(subagentTranscriptEntries(transcript));
  let lastResponseIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "bot" && message.kind === undefined)
      lastResponseIndex = index;
  });
  return messages.map((message, index) => ({
    ...message,
    copyAlways: index === lastResponseIndex,
    copyText: message.kind === undefined ? message.text : undefined,
    id: message.id ?? `${transcript.taskId}:message:${index}`,
  }));
}
