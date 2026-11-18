import type { AgentQuestion } from "./contract.gen.js";

/**
 * The user message that answers an Agent's questions, in the envelope
 * Codex's own apps send for `request_user_input_async`: one entry per
 * answered question, naming the question's item and index. Foundry answers
 * Claude's AskUserQuestion in the same envelope; the Worker hands a Claude
 * turn that still waits the answers themselves.
 */
const replyOpen = "<send_user_message_question_reply>";
const replyClose = "</send_user_message_question_reply>";
const replyPattern =
  /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/;

export interface AgentQuestionReply {
  itemId: string;
  index: number;
  question: string;
  answer: string;
  /** The question gets no answer; `reason` says why (a reply's entry). */
  noAnswer: boolean;
  reason: string;
}

/** Whether a message may carry answers (cheap, before parsing). */
export function mayBeAgentQuestionReply(text: string): boolean {
  return text.includes(replyOpen);
}

/**
 * The runtime's id of a question item: its message id is "<turn input>/<call
 * id>", and the reply names the call id. The card and the pending item both
 * derive it here, so their replies name the same question.
 */
export function nativeQuestionItemId(messageId: string): string {
  return messageId.split("/").at(-1) ?? messageId;
}

function questionItemId(itemId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", itemId, index]);
}

/** The user message that answers `questions` of item `itemId`. */
export function agentQuestionReplyText(
  itemId: string,
  questions: AgentQuestion[],
  answers: string[],
): string {
  const entries = questions.flatMap((question, index) => {
    const answer = answers[index]?.trim();
    return answer
      ? [
          {
            questionItemId: questionItemId(itemId, index),
            question: question.title,
            answer,
          },
        ]
      : [];
  });
  return `${replyOpen}\n${JSON.stringify(entries)}\n${replyClose}\n`;
}

/**
 * The user message that tells a waiting question (item `itemId`, its first
 * question `question`) it gets no answer, and why. The reason reaches the
 * model: a question Claude or Codex waits on is settled as declined, and
 * the message carries the reason.
 */
export function agentQuestionNoAnswerText(
  itemId: string,
  question: string,
  reason: string,
): string {
  const entry = {
    questionItemId: questionItemId(itemId, 0),
    question,
    noAnswer: true,
    reason,
  };
  return `${replyOpen}\n${JSON.stringify([entry])}\n${replyClose}\n`;
}

/** The answers a user message carries, if it is an answer. */
export function parseAgentQuestionReply(
  text: string,
): AgentQuestionReply[] | undefined {
  if (!mayBeAgentQuestionReply(text)) return undefined;
  const body = replyPattern.exec(text)?.[1];
  if (!body) return undefined;
  let entries: unknown;
  try {
    entries = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  const replies = entries.flatMap((entry): AgentQuestionReply[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    let target: unknown;
    try {
      target =
        typeof record.questionItemId === "string"
          ? JSON.parse(record.questionItemId)
          : record.questionItemId;
    } catch {
      return [];
    }
    if (
      !Array.isArray(target) ||
      typeof target[1] !== "string" ||
      typeof target[2] !== "number"
    )
      return [];
    return [
      {
        itemId: target[1],
        index: target[2],
        question: typeof record.question === "string" ? record.question : "",
        answer: typeof record.answer === "string" ? record.answer : "",
        noAnswer: record.noAnswer === true,
        reason: typeof record.reason === "string" ? record.reason : "",
      },
    ];
  });
  return replies.length ? replies : undefined;
}
