import type { AgentQuestion } from "@bd777/foundry-protocol";
import type {
  ChatMessageItem,
  ConversationQuestionState,
} from "./conversation-types";

/**
 * Codex answers an async question (`request_user_input_async`) through a
 * user message in this envelope, as its own apps send it: one entry per
 * answered question, naming the question's item and index.
 */
const replyOpen = "<send_user_message_question_reply>";
const replyClose = "</send_user_message_question_reply>";
const replyPattern =
  /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/;

/** A question's native item id, without a Foundry turn prefix ("<input>/"). */
const nativeItemId = (id: string) => id.split("/").at(-1) ?? id;

export interface AgentQuestionReply {
  itemId: string;
  index: number;
  question: string;
  answer: string;
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
            questionItemId: JSON.stringify([
              "request_user_input_async",
              itemId,
              index,
            ]),
            question: question.title,
            answer,
          },
        ]
      : [];
  });
  return `${replyOpen}\n${JSON.stringify(entries)}\n${replyClose}\n`;
}

/** The answers a user message carries, if it is an answer. */
export function parseAgentQuestionReply(
  text: string,
): AgentQuestionReply[] | undefined {
  if (!text.includes(replyOpen)) return undefined;
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
      },
    ];
  });
  return replies.length ? replies : undefined;
}

/**
 * Where each question stands, read from the transcript: answered by a later
 * reply; otherwise waiting while nothing else was said and the turn runs,
 * passed over once the turn ended (the Agent went on with an assumption) or
 * the person said something else. Replies show as their answers.
 */
export function withAgentQuestionStates(
  messages: ChatMessageItem[],
  active: boolean,
): ChatMessageItem[] {
  if (
    !messages.some(
      (message) =>
        message.questions?.length ||
        (message.role === "user" &&
          typeof message.text === "string" &&
          message.text.includes(replyOpen)),
    )
  )
    return messages;
  const answers = new Map<string, string[]>();
  const replies = messages.map((message) => {
    if (message.role !== "user" || typeof message.text !== "string") return;
    const reply = parseAgentQuestionReply(message.text);
    for (const entry of reply ?? []) {
      const given = answers.get(nativeItemId(entry.itemId)) ?? [];
      given[entry.index] = entry.answer;
      answers.set(nativeItemId(entry.itemId), given);
    }
    return reply;
  });
  const userAfter = new Array<boolean>(messages.length).fill(false);
  for (let index = messages.length - 2; index >= 0; index -= 1)
    userAfter[index] =
      userAfter[index + 1]! || messages[index + 1]!.role === "user";
  return messages.map((message, index) => {
    const reply = replies[index];
    if (reply)
      return {
        ...message,
        questionReply: reply.map(({ question, answer }) => ({
          question,
          answer,
        })),
      };
    if (!message.questions?.length || !message.questionItemId) return message;
    const given = answers.get(nativeItemId(message.questionItemId));
    const state: ConversationQuestionState = given
      ? "answered"
      : userAfter[index]
        ? "unanswered"
        : active
          ? "waiting"
          : "assumed";
    return {
      ...message,
      questionState: state,
      questionAnswers: given ? Array.from(given, (value) => value ?? "") : [],
    };
  });
}
