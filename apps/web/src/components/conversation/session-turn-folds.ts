import type { ChatMessageItem, SessionTurnsFold } from "./conversation-types";

/**
 * Turns the person did not start fold away so their own exchanges stay
 * readable: turns other sessions started (an orchestrating session is woken
 * by its children far more often than by its person), and turns the agent
 * ran on its own for a timer or after background work. A turn runs from its
 * input (a user message that was not steered into a running turn, or the
 * divider of a turn the agent ran on its own) to the next one. It folds when
 * the person did not start it and said nothing in it, it does not run now,
 * no question in it waits for an answer, and it is not the conversation's
 * latest turn. Consecutive such turns fold into one row; an expanded fold
 * keeps its row above its turns. "Only my conversation" hides them instead,
 * the latest one too.
 */

export interface FoldedTranscript {
  /** The rows to show: messages, with fold rows in place of folded turns. */
  rows: ChatMessageItem[];
  /** The fold row each folded message (shown or not) belongs to. */
  foldOf: ReadonlyMap<string, string>;
  /** Turns folded away, or hidden by "only my conversation". */
  foldedTurns: number;
}

type TurnOrigin = keyof SessionTurnsFold["origins"] | "person";

interface Turn {
  start: number;
  end: number;
  origin: TurnOrigin;
  folds: boolean;
}

function plainUserMessage(message: ChatMessageItem): boolean {
  return (
    message.role === "user" &&
    (message.kind === undefined || message.kind === "message")
  );
}

function startsTurn(message: ChatMessageItem): boolean {
  if (message.kind === "boundary") return Boolean(message.continuation);
  return plainUserMessage(message) && !message.steered && !message.steer;
}

function originOf(message: ChatMessageItem): TurnOrigin {
  if (message.kind === "boundary" && message.continuation)
    return message.continuation;
  return message.sentBy ? "session" : "person";
}

function runsNow(message: ChatMessageItem): boolean {
  return Boolean(message.streaming) || message.kind === "waiting";
}

function waitsForAnswer(message: ChatMessageItem): boolean {
  return (
    Boolean(message.questions?.length) && message.questionState !== "answered"
  );
}

function turnFolds(
  messages: readonly ChatMessageItem[],
  start: number,
  end: number,
): boolean {
  if (originOf(messages[start]!) === "person") return false;
  for (let index = start; index < end; index += 1) {
    const message = messages[index]!;
    if (runsNow(message) || waitsForAnswer(message)) return false;
    if (plainUserMessage(message) && !message.sentBy) return false;
  }
  return true;
}

export function foldSessionTurns(
  messages: readonly ChatMessageItem[],
  expanded: ReadonlySet<string>,
  { onlyMine = false }: { onlyMine?: boolean } = {},
): FoldedTranscript {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (startsTurn(message)) starts.push(index);
  });
  const turns: Turn[] = starts.map((start, index) => {
    const end = starts[index + 1] ?? messages.length;
    return {
      start,
      end,
      origin: originOf(messages[start]!),
      folds:
        (onlyMine || index < starts.length - 1) &&
        turnFolds(messages, start, end),
    };
  });
  const foldOf = new Map<string, string>();
  if (!turns.some((turn) => turn.folds)) {
    return { rows: messages as ChatMessageItem[], foldOf, foldedTurns: 0 };
  }
  const rows: ChatMessageItem[] = messages.slice(
    0,
    starts[0] ?? messages.length,
  );
  let foldedTurns = 0;
  for (let index = 0; index < turns.length;) {
    const turn = turns[index]!;
    if (!turn.folds) {
      rows.push(...messages.slice(turn.start, turn.end));
      index += 1;
      continue;
    }
    let last = index;
    while (turns[last + 1]?.folds) last += 1;
    const start = turn.start;
    const end = turns[last]!.end;
    const id = `session-turns:${messages[start]!.id}`;
    const senders = new Map<string, NonNullable<ChatMessageItem["sentBy"]>>();
    const origins = { session: 0, scheduled: 0, background: 0 };
    for (let at = index; at <= last; at += 1) {
      const origin = turns[at]!.origin;
      if (origin !== "person") origins[origin] += 1;
    }
    let lastAt: string | undefined;
    for (let position = start; position < end; position += 1) {
      const message = messages[position]!;
      foldOf.set(message.id, id);
      if (message.at) lastAt = message.at;
      if (message.sentBy && !senders.has(message.sentBy.sessionId))
        senders.set(message.sentBy.sessionId, message.sentBy);
    }
    foldedTurns += last - index + 1;
    if (onlyMine) {
      index = last + 1;
      continue;
    }
    const open = expanded.has(id);
    rows.push({
      id,
      kind: "session-turns",
      role: "bot",
      text: "",
      at: messages[start]!.at,
      sessionTurns: {
        turnCount: last - index + 1,
        origins,
        senders: [...senders.values()],
        firstAt: messages[start]!.at,
        lastAt,
        expanded: open,
      },
    });
    if (open) rows.push(...messages.slice(start, end));
    index = last + 1;
  }
  return { rows, foldOf, foldedTurns };
}
