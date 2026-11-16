import type { ChatMessageItem } from "./conversation-types";
import { isTurnInput, turnSource } from "./turn-source";

/**
 * "Only my conversation" hides turns the person did not start, the latest
 * one too. A turn runs from its input (a user message that was not steered
 * into a running turn, or the divider of a turn the agent ran on its own) to
 * the next one. It hides when the person did not start it and said nothing
 * in it, it does not run now, and no question in it waits for an answer.
 * Nothing is folded: every other turn stays inline under its own source row.
 */

export interface VisibleSessionTurns {
  /** The rows to show: every message, or those "only my conversation" keeps. */
  rows: ChatMessageItem[];
  /** Turns hidden now by "only my conversation". */
  hiddenTurns: number;
}

function plainUserMessage(message: ChatMessageItem): boolean {
  return (
    message.role === "user" &&
    (message.kind === undefined || message.kind === "message")
  );
}

function runsNow(message: ChatMessageItem): boolean {
  return Boolean(message.streaming) || message.kind === "waiting";
}

function waitsForAnswer(message: ChatMessageItem): boolean {
  return (
    Boolean(message.questions?.length) && message.questionState !== "answered"
  );
}

/** A person's message inside the turn: a steer, or the input of its own turn. */
function personSpoke(message: ChatMessageItem): boolean {
  return plainUserMessage(message) && !turnSource(message);
}

function turnHides(
  messages: readonly ChatMessageItem[],
  start: number,
  end: number,
): boolean {
  if (!turnSource(messages[start]!)) return false;
  for (let index = start; index < end; index += 1) {
    const message = messages[index]!;
    if (runsNow(message) || waitsForAnswer(message)) return false;
    if (personSpoke(message)) return false;
  }
  return true;
}

export function visibleSessionTurns(
  messages: readonly ChatMessageItem[],
  { onlyMine = false }: { onlyMine?: boolean } = {},
): VisibleSessionTurns {
  if (!onlyMine) return { rows: messages as ChatMessageItem[], hiddenTurns: 0 };
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isTurnInput(message)) starts.push(index);
  });
  const rows: ChatMessageItem[] = [];
  let hiddenTurns = 0;
  let shownFrom = 0;
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? messages.length;
    if (!turnHides(messages, start, end)) return;
    rows.push(...messages.slice(shownFrom, start));
    shownFrom = end;
    hiddenTurns += 1;
  });
  rows.push(...messages.slice(shownFrom));
  return { rows, hiddenTurns };
}
