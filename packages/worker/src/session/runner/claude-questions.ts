import {
  parseAgentQuestionReply,
  sessionSources,
  type AgentQuestion,
  type AgentSession,
  type TranscriptMessage,
} from "@bd777/foundry-protocol";
import { isPromptOnlySession, isUtilitySession } from "../session-roles.js";

/**
 * Claude Code's own question tool. The CLI offers it to the model only when
 * the host answers permission prompts (canUseTool); its call then waits for
 * the host's answer, which the CLI turns into the tool's result.
 */
export const claudeQuestionTool = "AskUserQuestion";

/** How long a question holds Claude's turn for the person: 3 minutes. */
export function claudeQuestionWaitMs(env = process.env): number {
  const value = Number(env.FOUNDRY_CLAUDE_QUESTION_WAIT_MS);
  return Number.isFinite(value) && value > 0 ? value : 3 * 60_000;
}

/**
 * Whether a person holds this session's conversation and can answer:
 * a chat they started, not an Issue's run, a role, a utility session or a
 * session another session started (orchestration, scheduled work).
 */
export function claudeAsksPerson(session: AgentSession): boolean {
  return (
    session.source === sessionSources.chat &&
    !session.parentSessionId?.trim() &&
    !session.issueId?.trim() &&
    !session.role &&
    !isUtilitySession(session) &&
    !isPromptOnlySession(session)
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

/** The questions of an AskUserQuestion call, as Foundry shows them. */
export function claudeQuestions(input: unknown): AgentQuestion[] {
  const questions =
    input && typeof input === "object"
      ? (input as Record<string, unknown>).questions
      : undefined;
  return records(questions).flatMap((question): AgentQuestion[] => {
    const title = text(question.question);
    if (!title) return [];
    const options = records(question.options).filter((option) =>
      text(option.label),
    );
    const header = text(question.header);
    return [
      {
        title,
        ...(header ? { header } : {}),
        ...(options.length
          ? {
              options: options.map((option) => text(option.label)),
              ...(options.some((option) => text(option.description))
                ? {
                    descriptions: options.map((option) =>
                      text(option.description),
                    ),
                  }
                : {}),
              ...(question.multiSelect === true ? { multiSelect: true } : {}),
              unranked: true,
            }
          : {}),
      },
    ];
  });
}

/** The transcript message of an AskUserQuestion call; its id is the call's. */
export function claudeQuestionMessage(
  callId: string,
  input: unknown,
): TranscriptMessage | undefined {
  const questions = claudeQuestions(input);
  if (!callId || questions.length === 0) return undefined;
  // What a view without the card shows: the questions and their choices.
  const fallback = questions
    .map((question) =>
      [
        question.title,
        ...(question.options ?? []).map((option, index) => {
          const description = question.descriptions?.[index];
          return `- ${option}${description ? ` — ${description}` : ""}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
  return { id: callId, kind: "assistant", text: fallback, questions };
}

/** canUseTool's answer, as the Claude Agent SDK takes it. */
export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

interface WaitingQuestion {
  input: Record<string, unknown>;
  settle: (result: ClaudePermissionResult) => void;
}

/**
 * Before Foundry answered permission prompts, Claude Code denied every
 * prompt in its sessions on its own: nobody could approve it. Other prompts
 * keep that answer; only questions reach the person.
 */
function deniedWithoutApprover(
  tool: string,
  options: { title?: string; decisionReason?: string },
): ClaudePermissionResult {
  const requested = options.title || options.decisionReason || tool;
  return {
    behavior: "deny",
    message: `Permission for this tool use was denied: it requires interactive approval, and permission prompts are not available in this session. The action was NOT performed. Do not claim it succeeded, and do not retry it in this session. What was requested: ${requested}`,
  };
}

/**
 * The questions a Claude process asked and waits on, by tool call. A
 * question waits for the person's answer up to its time; unanswered, Claude
 * hears so from its own tool (empty answers) and goes on.
 */
export class ClaudeQuestionGate {
  private readonly waiting = new Map<string, WaitingQuestion>();

  constructor(private readonly waitMs = claudeQuestionWaitMs()) {}

  /** The process's canUseTool. */
  readonly canUseTool = (
    tool: string,
    input: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      toolUseID?: string;
      title?: string;
      decisionReason?: string;
    },
  ): Promise<ClaudePermissionResult> =>
    tool === claudeQuestionTool && options.toolUseID
      ? this.wait(options.toolUseID, input, options.signal)
      : Promise.resolve(deniedWithoutApprover(tool, options));

  /** Whether a question waits for its answer. */
  get waits(): boolean {
    return this.waiting.size > 0;
  }

  private wait(
    callId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ClaudePermissionResult> {
    this.waiting.get(callId)?.settle(unanswered(input));
    return new Promise((resolve) => {
      const onAbort = () =>
        settle({ behavior: "deny", message: "The turn was interrupted." });
      const timer = setTimeout(() => settle(unanswered(input)), this.waitMs);
      const settle = (result: ClaudePermissionResult) => {
        if (this.waiting.get(callId)?.settle !== settle) return;
        this.waiting.delete(callId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      this.waiting.set(callId, { input, settle });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * A message the person sent while the turn runs. An answer to a waiting
   * question settles it; any other text while a question waits is what the
   * person replied instead of choosing (the tool's `response`). Returns
   * whether the message was taken: otherwise it goes to Claude as usual
   * (an answer to a question that no longer waits, or nothing waits).
   */
  take(message: string): boolean {
    if (this.waiting.size === 0) return false;
    const replies = parseAgentQuestionReply(message);
    if (replies) {
      let taken = false;
      for (const [callId, waiting] of [...this.waiting]) {
        const answers = replies.filter((reply) => reply.itemId === callId);
        if (answers.length === 0) continue;
        const questions = records(waiting.input.questions);
        const byQuestion: Record<string, string> = {};
        for (const reply of answers) {
          const question = text(questions[reply.index]?.question);
          if (question && reply.answer.trim())
            byQuestion[question] = reply.answer.trim();
        }
        waiting.settle({
          behavior: "allow",
          updatedInput: { ...waiting.input, answers: byQuestion },
        });
        taken = true;
      }
      return taken;
    }
    const reply = message.trim();
    const first = this.waiting.values().next().value;
    if (!reply || !first) return false;
    first.settle({
      behavior: "allow",
      updatedInput: { ...first.input, answers: {}, response: reply },
    });
    return true;
  }

  /** The process ends: nothing waits any more. */
  close(): void {
    for (const waiting of [...this.waiting.values()])
      waiting.settle({
        behavior: "deny",
        message: "The session's Claude process ended.",
      });
  }
}

/** No answer: Claude Code's tool then tells the model the user did not answer. */
function unanswered(input: Record<string, unknown>): ClaudePermissionResult {
  return { behavior: "allow", updatedInput: { ...input, answers: {} } };
}
