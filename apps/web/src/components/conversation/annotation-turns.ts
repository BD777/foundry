import type { ChatMessageItem } from "./conversation-types";
import { buildChatTurnAnchors } from "./chat-turn-navigation";
import { visibleSessionTurns } from "./session-turns";

/**
 * Turn numbers the way the transcript navigator counts them: a turn starts at
 * each person's message, over the rows that are shown.
 */
export function visibleTranscriptRows(
  messages: readonly ChatMessageItem[],
  onlyMine: boolean,
): ChatMessageItem[] {
  return [...visibleSessionTurns(messages, { onlyMine }).rows];
}

export function transcriptTurnCount(rows: readonly ChatMessageItem[]): number {
  return buildChatTurnAnchors(rows).length;
}

/** The 1-based turn an answer belongs to, or 0 when it is not in the rows. */
export function answerTurnNumber(
  rows: readonly ChatMessageItem[],
  answerId: string,
): number {
  const answerIndex = rows.findIndex((row) => row.id === answerId);
  if (answerIndex < 0) return 0;
  return buildChatTurnAnchors(rows).filter(
    (anchor) => anchor.messageIndex < answerIndex,
  ).length;
}
