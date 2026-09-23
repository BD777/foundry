import type { ChatMessageItem } from "./conversation-types";

export const CHAT_VIRTUOSO_OVERSCAN_PX = 900;
export const CHAT_VIRTUOSO_MIN_OVERSCAN_ITEMS = 8;

export function estimateChatMessageHeight(
  message: ChatMessageItem | undefined,
): number {
  if (!message) {
    return 80;
  }
  if (message.kind === "boundary") {
    return 32;
  }
  if (message.kind === "process" || message.kind === "tool") {
    return 38;
  }
  if (message.kind === "failure") {
    return 76;
  }

  const text = typeof message.text === "string" ? message.text : "";
  const explicitLines = text.split(/\r?\n/).length;
  const charactersPerLine = message.role === "user" ? 48 : 72;
  const wrappedLines = Math.ceil(text.length / charactersPerLine);
  const structuralBlocks = (
    text.match(/^(?:\s*$|#{1,6}\s|[-*+]\s|\d+\.\s|```|\|)/gm) ?? []
  ).length;
  const attachmentHeight = message.attachments?.length ? 180 : 0;

  return Math.max(
    64,
    48 +
      Math.max(explicitLines, wrappedLines) * 24 +
      structuralBlocks * 6 +
      attachmentHeight,
  );
}
