import {
  mayBeAgentQuestionReply,
  parseAgentQuestionReply,
} from "@bd777/foundry-protocol";
import type {
  ChatMessageItem,
  ConversationQuestionState,
} from "./conversation-types";

export {
  agentQuestionReplyText,
  parseAgentQuestionReply,
  type AgentQuestionReply,
} from "@bd777/foundry-protocol";

/** A question's native item id, without a Foundry turn prefix ("<input>/"). */
const nativeItemId = (id: string) => id.split("/").at(-1) ?? id;

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
          mayBeAgentQuestionReply(message.text)),
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
