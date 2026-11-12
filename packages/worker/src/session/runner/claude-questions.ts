import {
  parseAgentQuestionReply,
  sessionSources,
  type AgentQuestion,
  type AgentQuestionReply,
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

/**
 * Who answers a session's questions and permission prompts: "person", who
 * holds its chat and sees the turn wait; "parent", the session that created
 * it, which hears of the prompt through its inbox (the prompt ends the turn
 * and the answer is the next message; with no live parent it waits in the
 * chat for the person); undefined, nobody: prompts are denied at once. The
 * server resolves the chain of parents on dispatch (questionsTo); a session
 * from a server that does not yet says nothing, and only the person's own
 * chat asks. One rule for every runtime: Claude's canUseTool below, and
 * Codex's approval, requestUserInput and elicitation server requests
 * (codex-questions.ts), which take the same answer and reply envelope.
 */
export type SessionQuestionsTo = "person" | "parent";

export function sessionQuestionsTo(
  session: AgentSession,
): SessionQuestionsTo | undefined {
  if (
    session.issueId?.trim() ||
    session.role ||
    isUtilitySession(session) ||
    isPromptOnlySession(session)
  )
    return undefined;
  if (session.questionsTo) return session.questionsTo;
  return claudeAsksPerson(session) ? "person" : undefined;
}

/** Claude Code's plan approval: leaving plan mode waits for a yes. */
export const claudePlanApprovalTool = "ExitPlanMode";

/** The choices of an approval; any other answer denies, giving its reason. */
export const approvalAnswers = { approve: "Approve", deny: "Deny" } as const;

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
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      /** Claude Code's permission updates (an approved plan's next mode). */
      updatedPermissions?: {
        type: "setMode";
        mode: string;
        destination: "session";
      }[];
    }
  | { behavior: "deny"; message: string };

interface WaitingQuestion {
  input: Record<string, unknown>;
  /** Answers it; false when it no longer waits. */
  settle: (result: ClaudePermissionResult) => boolean;
  /** Ends its wait without an answer. */
  lapse: (result: ClaudePermissionResult) => void;
  /** An approval of this tool, not a question. */
  approves?: string;
}

/** What canUseTool is told about the call, as the SDK passes it. */
interface ClaudePromptOptions {
  signal?: AbortSignal;
  toolUseID?: string;
  title?: string;
  decisionReason?: string;
}

/**
 * Before Foundry answered permission prompts, Claude Code denied every
 * prompt in its sessions on its own: nobody could approve it. Prompts that
 * are neither a question nor a plan approval keep that answer.
 */
function deniedWithoutApprover(
  tool: string,
  options: { title?: string; decisionReason?: string },
): ClaudePermissionResult {
  const requested = options.title || options.decisionReason || tool;
  return {
    behavior: "deny",
    message: `Permission for ${requested} was denied: no interactive approver is available in this session. The action was NOT performed.`,
  };
}

/** No one approved in time: the action did not happen. */
function deniedUnanswered(
  tool: string,
  waitMs: number,
): ClaudePermissionResult {
  return {
    behavior: "deny",
    message: `Permission for ${tool} was denied: timed out after ${Math.round(waitMs)}ms. The action was NOT performed.`,
  };
}

/**
 * An approved call. An approved plan leaves plan mode for `afterPlan`, as
 * native Claude Code's approval does for the mode its person picks.
 */
function approved(
  tool: string,
  input: Record<string, unknown>,
  afterPlan?: string,
): ClaudePermissionResult {
  return tool === claudePlanApprovalTool && afterPlan
    ? {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [
          { type: "setMode", mode: afterPlan, destination: "session" },
        ],
      }
    : { behavior: "allow", updatedInput: input };
}

/** The answer to an approval: "Approve" allows; anything else denies. */
function approvalResult(
  tool: string,
  input: Record<string, unknown>,
  answer: string,
  afterPlan?: string,
): ClaudePermissionResult {
  if (approvesAnswer(answer)) return approved(tool, input, afterPlan);
  const denial = denialReason(answer);
  const reason = denial ? `: ${denial}` : ".";
  return {
    behavior: "deny",
    message:
      tool === claudePlanApprovalTool
        ? `The plan was not approved${reason} NOT performed.`
        : `This was not approved${reason} The action was NOT performed.`,
  };
}

/** The question card of an approval: the plan, approve or deny. */
export function claudeApprovalMessage(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  options: { title?: string; decisionReason?: string } = {},
): TranscriptMessage {
  const plan = text(input.plan);
  const title =
    tool === claudePlanApprovalTool
      ? "Approve this plan?"
      : options.title || `Allow ${tool}?`;
  const detail =
    plan ||
    (tool === claudePlanApprovalTool
      ? ""
      : ["```json", JSON.stringify(input, null, 2).slice(0, 4000), "```"].join(
          "\n",
        ));
  return approvalQuestionMessage(id, title, detail);
}

/** The question card of an approval, for any runtime: approve or deny. */
export function approvalQuestionMessage(
  id: string,
  title: string,
  detail: string,
): TranscriptMessage {
  return {
    id,
    kind: "assistant",
    text: detail ? `${title}\n\n${detail}` : title,
    questions: [
      {
        title,
        options: [approvalAnswers.approve, approvalAnswers.deny],
        unranked: true,
        approval: true,
        ...(detail ? { detail } : {}),
      },
    ],
  };
}

/** Whether an approval's answer approves ("Approve", in any case). */
export function approvesAnswer(answer: string): boolean {
  return answer.trim().toLowerCase() === approvalAnswers.approve.toLowerCase();
}

/** The reason an approval's answer gives to deny, if any beyond "Deny". */
export function denialReason(answer: string): string {
  const reply = answer.trim();
  return reply.toLowerCase() === approvalAnswers.deny.toLowerCase()
    ? ""
    : reply;
}

/** A child's question went to its parent: the turn ends to wait for it. */
const relayedQuestion: ClaudePermissionResult = {
  behavior: "deny",
  message:
    "The question was relayed to the session that created you; its answer arrives as your next message. NOT answered.",
};

/** A child's approval went to its parent: the turn ends to wait for it. */
function relayedApproval(tool: string): ClaudePermissionResult {
  return {
    behavior: "deny",
    message: `Approval for ${tool} was relayed to the session that created you. NOT performed yet; an approval in your next message allows the same call once.`,
  };
}

/**
 * A child's approvals outlive its Claude process: the approval comes with a
 * later turn, perhaps in another process. By Foundry session: the approval
 * items it asked (item id → tool), and the tools approved once.
 */
const relayedApprovals = new Map<
  string,
  { asked: Map<string, string>; approved: Set<string> }
>();

function relayedApprovalsOf(sessionId: string) {
  let entry = relayedApprovals.get(sessionId);
  if (!entry) {
    entry = { asked: new Map(), approved: new Set() };
    relayedApprovals.set(sessionId, entry);
  }
  return entry;
}

/** A question's item id, without a Foundry turn prefix ("<input>/"). */
export const nativeItemId = (id: string) => id.split("/").at(-1) ?? id;

/**
 * The questions and approvals a Claude process asked and waits on, by item.
 * Where the person answers (`person`), a prompt waits for the answer up to
 * its time; unanswered, a question hears so from its own tool (empty
 * answers) and an approval is denied. Where a parent answers (`parent`), a
 * prompt is shown, relayed by the server, and ends the turn; its answer is
 * a later message.
 */
export class ClaudeQuestionGate {
  private readonly waiting = new Map<string, WaitingQuestion>();
  private readonly waitMs: number;

  constructor(
    private readonly to: SessionQuestionsTo,
    private readonly host: {
      sessionId: string;
      /** Shows a prompt the stream does not (an approval). */
      show: (message: TranscriptMessage) => void;
      waitMs?: number;
      /** The mode an approved plan continues in (claudePermissionModeAfterPlan). */
      afterPlan?: string;
      /**
       * A waiting prompt stopped waiting without an answer (timed out,
       * interrupted, the process ended): its item id.
       */
      settled?: (itemId: string) => void;
    },
  ) {
    this.waitMs = host.waitMs ?? claudeQuestionWaitMs();
  }

  /** The process's canUseTool. */
  readonly canUseTool = (
    tool: string,
    input: Record<string, unknown>,
    options: ClaudePromptOptions,
  ): Promise<ClaudePermissionResult> => {
    const callId = options.toolUseID;
    if (tool === claudeQuestionTool && callId)
      return this.to === "person"
        ? this.wait(callId, input, options.signal)
        : Promise.resolve(relayedQuestion);
    if (tool === claudePlanApprovalTool && callId)
      return this.approve(tool, callId, input, options);
    return Promise.resolve(deniedWithoutApprover(tool, options));
  };

  /** A prompt as the chat shows it: a relayed one waits for the next turn. */
  shown(message: TranscriptMessage): TranscriptMessage {
    return this.to === "parent" && message.questions?.length
      ? { ...message, delivery: "next_turn" }
      : message;
  }

  /** Whether a question waits for its answer. */
  get waits(): boolean {
    return this.waiting.size > 0;
  }

  private approve(
    tool: string,
    callId: string,
    input: Record<string, unknown>,
    options: ClaudePromptOptions,
  ): Promise<ClaudePermissionResult> {
    const itemId = `approval_${callId}`;
    if (this.to === "parent") {
      const relayed = relayedApprovalsOf(this.host.sessionId);
      if (relayed.approved.delete(tool))
        return Promise.resolve(approved(tool, input, this.host.afterPlan));
      relayed.asked.set(itemId, tool);
      this.host.show(
        this.shown(claudeApprovalMessage(itemId, tool, input, options)),
      );
      return Promise.resolve(relayedApproval(tool));
    }
    this.host.show(claudeApprovalMessage(itemId, tool, input, options));
    return this.wait(itemId, input, options.signal, tool);
  }

  private wait(
    itemId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    approves?: string,
  ): Promise<ClaudePermissionResult> {
    const timedOut = () =>
      approves ? deniedUnanswered(approves, this.waitMs) : unanswered(input);
    this.waiting.get(itemId)?.lapse(timedOut());
    return new Promise((resolve) => {
      const onAbort = () =>
        lapse({
          behavior: "deny",
          message: "The turn was interrupted; NOT performed.",
        });
      const timer = setTimeout(() => lapse(timedOut()), this.waitMs);
      const settle = (result: ClaudePermissionResult) => {
        if (this.waiting.get(itemId)?.settle !== settle) return false;
        this.waiting.delete(itemId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      };
      // Settled without the person's answer: Pending closes it.
      const lapse = (result: ClaudePermissionResult) => {
        if (settle(result)) this.host.settled?.(itemId);
      };
      this.waiting.set(itemId, { input, settle, lapse, approves });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * A message that reaches the session (a turn's input or a steer, from
   * anyone): an approval a relayed prompt waited for is noted, so the
   * tool's next call is allowed. The message still goes to Claude.
   */
  observe(message: string): void {
    if (this.to !== "parent") return;
    const relayed = relayedApprovals.get(this.host.sessionId);
    if (!relayed?.asked.size) return;
    for (const reply of parseAgentQuestionReply(message) ?? []) {
      const tool = relayed.asked.get(nativeItemId(reply.itemId));
      if (!tool) continue;
      relayed.asked.delete(nativeItemId(reply.itemId));
      if (approvalResult(tool, {}, reply.answer).behavior === "allow")
        relayed.approved.add(tool);
    }
  }

  /**
   * A message the person sent while the turn runs. An answer to a waiting
   * question or approval settles it; any other text while one waits is what
   * the person replied instead of choosing (a question's `response`, an
   * approval's reason to deny). Returns whether the message was taken:
   * otherwise it goes to Claude as usual (an answer to a question that no
   * longer waits, or nothing waits).
   */
  take(message: string): boolean {
    if (this.waiting.size === 0) return false;
    const replies = parseAgentQuestionReply(message);
    if (replies) {
      let taken = false;
      for (const [itemId, waiting] of [...this.waiting]) {
        const answers = replies.filter(
          (reply) => nativeItemId(reply.itemId) === itemId,
        );
        if (answers.length === 0) continue;
        waiting.settle(settled(waiting, answers, this.host.afterPlan));
        taken = true;
      }
      return taken;
    }
    const reply = message.trim();
    const first = this.waiting.values().next().value;
    if (!reply || !first) return false;
    first.settle(
      first.approves
        ? approvalResult(
            first.approves,
            first.input,
            reply,
            this.host.afterPlan,
          )
        : {
            behavior: "allow",
            updatedInput: { ...first.input, answers: {}, response: reply },
          },
    );
    return true;
  }

  /** The process ends: nothing waits any more. */
  close(): void {
    for (const waiting of [...this.waiting.values()])
      waiting.lapse({
        behavior: "deny",
        message: "The session's Claude process ended; NOT performed.",
      });
  }
}

/** A waiting prompt's result from its answers. */
function settled(
  waiting: WaitingQuestion,
  answers: AgentQuestionReply[],
  afterPlan?: string,
): ClaudePermissionResult {
  if (waiting.approves)
    return approvalResult(
      waiting.approves,
      waiting.input,
      answers.find((reply) => reply.index === 0)?.answer ?? "",
      afterPlan,
    );
  const questions = records(waiting.input.questions);
  const byQuestion: Record<string, string> = {};
  for (const reply of answers) {
    const question = text(questions[reply.index]?.question);
    if (question && reply.answer.trim())
      byQuestion[question] = reply.answer.trim();
  }
  return {
    behavior: "allow",
    updatedInput: { ...waiting.input, answers: byQuestion },
  };
}

/** No answer: Claude Code's tool then tells the model the user did not answer. */
function unanswered(input: Record<string, unknown>): ClaudePermissionResult {
  return { behavior: "allow", updatedInput: { ...input, answers: {} } };
}
