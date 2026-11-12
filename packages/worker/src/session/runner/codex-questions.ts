import {
  parseAgentQuestionReply,
  type AgentQuestion,
  type AgentQuestionReply,
  type TranscriptMessage,
} from "@bd777/foundry-protocol";
import { codexNoResponse } from "../../harness/agent-runtime/codex-client.js";
import {
  approvalQuestionMessage,
  approvesAnswer,
  claudeQuestionWaitMs,
  denialReason,
  nativeItemId,
  type SessionQuestionsTo,
} from "./claude-questions.js";

/**
 * The server requests of Codex's app-server (0.167 schema) that ask whoever
 * holds the session: approvals, the request_user_input tool and MCP
 * elicitations. They follow the same routing as Claude's prompts
 * (sessionQuestionsTo): the person's question card, a relay to the parent
 * session, or an immediate decline. The legacy v1 approvals come only on
 * v1 conversations, which Foundry does not start; they map the same way.
 */
export const codexPromptMethods = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  userInput: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
  legacyCommandApproval: "execCommandApproval",
  legacyPatchApproval: "applyPatchApproval",
} as const;

/** Codex's notification that a server request no longer waits. */
export const codexRequestResolved = "serverRequest/resolved";

/** What a Codex prompt asks, and the response each outcome sends. */
interface CodexPrompt {
  /** The transcript message's id; answers name it. */
  itemId: string;
  message: TranscriptMessage;
  /** What the prompt is about, for the notes Codex is sent. */
  what: string;
  /** An approval: what a relayed approval allows again once. */
  approvalKey?: string;
  /** The response to the person's answers (by question index). */
  accept: (answers: string[]) => unknown;
  /** The response that declines (an approval denied, nothing answered). */
  decline: unknown;
}

/** The outcome of a prompt: Codex's response, and a note for the model. */
export interface CodexPromptAnswer {
  result: unknown;
  /**
   * Said to the model in the turn (turn/steer): a decline's response
   * carries no reason, so this tells the model why and what to do.
   */
  note?: string;
}

/** Where a prompt is shown: absent while no Foundry turn holds it. */
export interface CodexPromptHost {
  show?: (message: TranscriptMessage) => void;
  /** A prompt stopped waiting without an answer: its item id. */
  settled?: (itemId: string) => void;
  /** The item a request is about, as the turn last reported it. */
  item?: (itemId: string) => Record<string, unknown> | undefined;
}

interface WaitingPrompt {
  prompt: CodexPrompt;
  requestId: unknown;
  settle: (answer: CodexPromptAnswer) => boolean;
  lapse: (answer: CodexPromptAnswer) => void;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function fenced(language: string, body: string): string {
  return ["```" + language, body.slice(0, 4000), "```"].join("\n");
}

function paragraphs(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part?.trim()).join("\n\n");
}

/** The paths of a file change item (fileChange.changes[].path). */
function changedPaths(item: Record<string, unknown> | undefined): string[] {
  return records(item?.changes)
    .map((change) => text(change.path))
    .filter(Boolean);
}

function approvalPrompt(
  itemId: string,
  title: string,
  detail: string,
  what: string,
  approvalKey: string,
  accept: unknown,
  decline: unknown,
): CodexPrompt {
  return {
    itemId,
    message: approvalQuestionMessage(itemId, title, detail),
    what,
    approvalKey,
    accept: (answers) => (approvesAnswer(answers[0] ?? "") ? accept : decline),
    decline,
  };
}

function commandApproval(params: any): CodexPrompt {
  const command = text(params.command);
  const cwd = text(params.cwd);
  const stdin = params.kind === "writeStdin";
  const network = params.networkApprovalContext
    ? `Network access: ${JSON.stringify(params.networkApprovalContext)}`
    : "";
  return approvalPrompt(
    `approval_${text(params.approvalId) || text(params.itemId)}`,
    stdin ? "Allow input to a running command?" : "Allow this command?",
    paragraphs(
      command ? fenced("sh", command) : "",
      cwd ? `In \`${cwd}\`` : "",
      text(params.reason),
      network,
    ),
    stdin ? "the input to a running command" : `the command \`${command}\``,
    `command\u0000${cwd}\u0000${command}\u0000${params.kind ?? "command"}`,
    { decision: "accept" },
    { decision: "decline" },
  );
}

function fileChangeApproval(
  params: any,
  item: Record<string, unknown> | undefined,
): CodexPrompt {
  const paths = changedPaths(item);
  return approvalPrompt(
    `approval_${text(params.itemId)}`,
    "Allow these file changes?",
    paragraphs(
      paths.map((path) => `- \`${path}\``).join("\n"),
      text(params.grantRoot)
        ? `Writes under \`${text(params.grantRoot)}\` for the rest of the session`
        : "",
      text(params.reason),
    ),
    paths.length ? `the changes to ${paths.join(", ")}` : "the file changes",
    `fileChange\u0000${paths.join("\u0000")}\u0000${text(params.grantRoot)}`,
    { decision: "accept" },
    { decision: "decline" },
  );
}

function permissionsApproval(params: any): CodexPrompt {
  const permissions = record(params.permissions);
  return approvalPrompt(
    `approval_${text(params.itemId)}`,
    "Grant these permissions?",
    paragraphs(
      fenced("json", JSON.stringify(permissions, null, 2)),
      text(params.cwd) ? `In \`${text(params.cwd)}\`` : "",
      text(params.reason),
    ),
    "the requested permissions",
    `permissions\u0000${JSON.stringify(permissions)}`,
    { permissions, scope: "turn" },
    { permissions: {} },
  );
}

function legacyCommandApproval(params: any): CodexPrompt {
  const command = Array.isArray(params.command)
    ? params.command.map(String).join(" ")
    : text(params.command);
  return approvalPrompt(
    `approval_${text(params.approvalId) || text(params.callId)}`,
    "Allow this command?",
    paragraphs(
      fenced("sh", command),
      text(params.cwd) ? `In \`${text(params.cwd)}\`` : "",
      text(params.reason),
    ),
    `the command \`${command}\``,
    `command\u0000${text(params.cwd)}\u0000${command}\u0000command`,
    "approved",
    { denied: { rejection: "Not approved." } },
  );
}

function legacyPatchApproval(params: any): CodexPrompt {
  const paths = Object.keys(record(params.fileChanges));
  return approvalPrompt(
    `approval_${text(params.callId)}`,
    "Allow these file changes?",
    paragraphs(
      paths.map((path) => `- \`${path}\``).join("\n"),
      text(params.reason),
    ),
    paths.length ? `the changes to ${paths.join(", ")}` : "the file changes",
    `fileChange\u0000${paths.join("\u0000")}\u0000${text(params.grantRoot)}`,
    "approved",
    { denied: { rejection: "Not approved." } },
  );
}

/** The question card of a request_user_input call; answers by question id. */
function userInputPrompt(params: any): CodexPrompt | undefined {
  const asked = records(params.questions).filter((question) =>
    text(question.question),
  );
  // A secret would be written into the chat's transcript: never asked here.
  if (!asked.length || asked.some((question) => question.isSecret === true))
    return undefined;
  const itemId = text(params.itemId);
  const questions = asked.map((question): AgentQuestion => {
    const options = records(question.options).filter((option) =>
      text(option.label),
    );
    const header = text(question.header);
    return {
      title: text(question.question),
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
            unranked: true,
          }
        : {}),
    };
  });
  return {
    itemId,
    message: questionMessage(itemId, questions),
    what: "your question",
    accept: (answers) => ({
      answers: Object.fromEntries(
        asked.flatMap((question, index) =>
          answers[index]?.trim()
            ? [[text(question.id), { answers: [answers[index]!.trim()] }]]
            : [],
        ),
      ),
    }),
    decline: { answers: {} },
  };
}

function questionMessage(
  itemId: string,
  questions: AgentQuestion[],
): TranscriptMessage {
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
  return { id: itemId, kind: "assistant", text: fallback, questions };
}

const yes = "Yes";
const no = "No";

/** One field of an elicitation form, as a question and its answer's value. */
interface ElicitationField {
  name: string;
  question: AgentQuestion;
  required: boolean;
  value: (answer: string) => unknown;
}

function elicitationField(
  name: string,
  schema: Record<string, unknown>,
  required: boolean,
): ElicitationField | undefined {
  const title = text(schema.title) || text(schema.description) || name;
  const description =
    text(schema.title) && text(schema.description)
      ? text(schema.description)
      : "";
  const header = name.slice(0, 12);
  const choices = (values: unknown[], labels?: unknown[]) => {
    const options = values.map((value, index) =>
      text(labels?.[index]) ? text(labels![index]) : String(value),
    );
    return {
      options,
      value: (answer: string) => {
        const picked = answer
          .split(", ")
          .map((part) => values[options.indexOf(part)])
          .filter((value) => value !== undefined);
        return schema.type === "array" ? picked : picked[0];
      },
    };
  };
  let options: string[] | undefined;
  let value: (answer: string) => unknown = (answer) => answer;
  const oneOf = records(schema.oneOf ?? schema.anyOf);
  const items = record(schema.items);
  if (Array.isArray(schema.enum)) {
    ({ options, value } = choices(
      schema.enum,
      schema.enumNames as unknown[] | undefined,
    ));
  } else if (oneOf.length && oneOf.every((entry) => "const" in entry)) {
    ({ options, value } = choices(
      oneOf.map((entry) => entry.const),
      oneOf.map((entry) => entry.title),
    ));
  } else if (schema.type === "array") {
    const itemChoices = records(items.anyOf ?? items.oneOf);
    if (Array.isArray(items.enum)) ({ options, value } = choices(items.enum));
    else if (itemChoices.every((entry) => "const" in entry))
      ({ options, value } = choices(
        itemChoices.map((entry) => entry.const),
        itemChoices.map((entry) => entry.title),
      ));
    else return undefined;
  } else if (schema.type === "boolean") {
    options = [yes, no];
    value = (answer) =>
      answer === yes ? true : answer === no ? false : undefined;
  } else if (schema.type === "number" || schema.type === "integer") {
    value = (answer) => {
      const number = Number(answer);
      return Number.isFinite(number) &&
        (schema.type === "number" || Number.isInteger(number))
        ? number
        : undefined;
    };
  } else if (schema.type !== "string") return undefined;
  return {
    name,
    required,
    value,
    question: {
      title,
      header,
      ...(options?.length
        ? {
            options,
            unranked: true,
            ...(schema.type === "array" ? { multiSelect: true } : {}),
          }
        : {}),
      ...(description ? { detail: description } : {}),
    },
  };
}

/**
 * An MCP server's elicitation: a form becomes its questions (one per
 * field); a form without fields, a URL to open, or a request Codex makes
 * for an MCP tool's approval becomes an approval. A device-signed user
 * verification cannot be given here (undefined: declined).
 */
function elicitationPrompt(
  requestId: unknown,
  params: any,
): CodexPrompt | undefined {
  const itemId = `elicitation_${String(requestId)}`;
  const server = text(params.serverName) || "An MCP server";
  const message = text(params.message);
  const what = `the request of the MCP server ${server}`;
  if (params.mode === "url") {
    const url = text(params.url);
    return approvalPrompt(
      itemId,
      message || `Open this page for ${server}?`,
      paragraphs(`MCP server: ${server}`, url ? `<${url}>` : ""),
      what,
      `elicitation\u0000${server}\u0000${url}`,
      { action: "accept" },
      { action: "decline" },
    );
  }
  if (!["form", "openai/form", "openaiForm"].includes(params.mode))
    return undefined;
  const schema = record(params.requestedSchema);
  const properties = Object.entries(record(schema.properties));
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  if (!properties.length)
    return approvalPrompt(
      itemId,
      message || `Allow the request of ${server}?`,
      `MCP server: ${server}`,
      what,
      `elicitation\u0000${server}\u0000${message}`,
      { action: "accept", content: {} },
      { action: "decline" },
    );
  const fields = properties.map(([name, field]) =>
    elicitationField(name, record(field), required.has(name)),
  );
  if (fields.some((field) => !field)) return undefined;
  const form = fields as ElicitationField[];
  const questions = form.map((field) => field.question);
  return {
    itemId,
    message: {
      ...questionMessage(itemId, questions),
      text: paragraphs(message, questionMessage(itemId, questions).text),
    },
    what,
    accept: (answers) => {
      const content: Record<string, unknown> = {};
      for (const [index, field] of form.entries()) {
        const answer = answers[index]?.trim() ?? "";
        const value = answer ? field.value(answer) : undefined;
        if (value === undefined) {
          if (field.required) return { action: "decline" };
          continue;
        }
        content[field.name] = value;
      }
      return { action: "accept", content };
    },
    decline: { action: "decline" },
  };
}

/** The prompt of a server request; undefined for one nobody may answer. */
function codexPrompt(
  method: string,
  params: any,
  requestId: unknown,
  host: CodexPromptHost,
): CodexPrompt | undefined {
  switch (method) {
    case codexPromptMethods.commandApproval:
      return commandApproval(params);
    case codexPromptMethods.fileChangeApproval:
      return fileChangeApproval(params, host.item?.(text(params.itemId)));
    case codexPromptMethods.permissionsApproval:
      return permissionsApproval(params);
    case codexPromptMethods.legacyCommandApproval:
      return legacyCommandApproval(params);
    case codexPromptMethods.legacyPatchApproval:
      return legacyPatchApproval(params);
    case codexPromptMethods.userInput:
      return userInputPrompt(params);
    case codexPromptMethods.elicitation:
      return elicitationPrompt(requestId, params);
  }
  return undefined;
}

/** The decline of a request no prompt maps (a user verification, secrets). */
function unmappedDecline(method: string): unknown {
  return method === codexPromptMethods.userInput
    ? { answers: {} }
    : { action: "decline" };
}

const notes = {
  nobody: (what: string) =>
    `Foundry: ${what} has no approver in this session; NOT performed or answered.`,
  unanswered: (what: string, waitMs: number) =>
    `Foundry: ${what} was not approved: timed out after ${Math.round(waitMs)}ms; NOT performed.`,
  denied: (what: string, reason: string) =>
    `Foundry: ${what} was not approved${reason ? `: ${reason}` : "."} It was NOT performed.`,
  relayedApproval: (what: string) =>
    `Foundry: ${what} approval was relayed to the session that created you; NOT performed yet. An approval in your next message allows the same request once.`,
  relayedQuestion:
    "Foundry: question relayed to the session that created you; answer arrives as your next message. NOT answered.",
  ownTurn: (what: string) =>
    `Foundry: ${what} has no approver in this turn; NOT performed or answered. Say in your reply what you need and continue with what you can do.`,
};

/**
 * A child's relayed approvals outlive the turn that asked: the approval
 * comes with a later turn. By Foundry session: the approval items it asked
 * (item id → what it allows), and what was approved once.
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

/**
 * Codex's prompts for one thread, routed like Claude's (ClaudeQuestionGate):
 * `person` shows the question card and holds the request until the person
 * answers or the wait ends (then it is declined); `parent` shows the prompt
 * for the next turn (the server relays it), declines at once and reports that
 * the answer arrives next turn; an approval the next message grants lets the
 * same request through once; nobody (undefined) declines at once.
 */
export class CodexQuestionGate {
  private readonly waiting = new Map<string, WaitingPrompt>();
  private readonly waitMs: number;

  constructor(
    private readonly to: SessionQuestionsTo | undefined,
    private readonly sessionId: string,
    waitMs?: number,
  ) {
    this.waitMs = waitMs ?? claudeQuestionWaitMs();
  }

  /** Whether the method is a prompt this gate answers. */
  static handles(method: string): boolean {
    return (Object.values(codexPromptMethods) as string[]).includes(method);
  }

  /** The answer to one server request. */
  answer(
    method: string,
    params: any,
    requestId: unknown,
    host: CodexPromptHost,
  ): Promise<CodexPromptAnswer> {
    const prompt = codexPrompt(method, params, requestId, host);
    if (!prompt)
      return Promise.resolve({
        result: unmappedDecline(method),
        note: notes.nobody(
          method === codexPromptMethods.userInput
            ? "your question"
            : "this request",
        ),
      });
    if (!this.to)
      return Promise.resolve({
        result: prompt.decline,
        note: notes.nobody(prompt.what),
      });
    if (!host.show)
      return Promise.resolve({
        result: prompt.decline,
        note: notes.ownTurn(prompt.what),
      });
    if (this.to === "parent") return Promise.resolve(this.relay(prompt, host));
    host.show(prompt.message);
    return this.wait(prompt, requestId, host);
  }

  private relay(prompt: CodexPrompt, host: CodexPromptHost): CodexPromptAnswer {
    const relayed = relayedApprovalsOf(this.sessionId);
    if (prompt.approvalKey && relayed.approved.delete(prompt.approvalKey))
      return { result: prompt.accept(["Approve"]) };
    if (prompt.approvalKey)
      relayed.asked.set(prompt.itemId, prompt.approvalKey);
    host.show!({ ...prompt.message, delivery: "next_turn" });
    return {
      result: prompt.decline,
      note: prompt.approvalKey
        ? notes.relayedApproval(prompt.what)
        : notes.relayedQuestion,
    };
  }

  private wait(
    prompt: CodexPrompt,
    requestId: unknown,
    host: CodexPromptHost,
  ): Promise<CodexPromptAnswer> {
    const itemId = prompt.itemId;
    const unanswered: CodexPromptAnswer = {
      result: prompt.decline,
      ...(prompt.approvalKey
        ? { note: notes.unanswered(prompt.what, this.waitMs) }
        : {}),
    };
    this.waiting.get(itemId)?.lapse(unanswered);
    return new Promise((resolve) => {
      const timer = setTimeout(() => lapse(unanswered), this.waitMs);
      const settle = (answer: CodexPromptAnswer) => {
        if (this.waiting.get(itemId)?.settle !== settle) return false;
        this.waiting.delete(itemId);
        clearTimeout(timer);
        resolve(answer);
        return true;
      };
      // Settled without the person's answer: Pending closes it.
      const lapse = (answer: CodexPromptAnswer) => {
        if (settle(answer)) host.settled?.(itemId);
      };
      this.waiting.set(itemId, { prompt, requestId, settle, lapse });
    });
  }

  /** Whether a prompt waits for the person. */
  get waits(): boolean {
    return this.waiting.size > 0;
  }

  /**
   * A message the person sent while the turn runs: an answer to a waiting
   * prompt answers it; any other text while one waits is the reply to the
   * first (a question's answer, an approval's reason to deny). Returns
   * whether it was taken; otherwise it goes to Codex as usual.
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
        waiting.settle(answered(waiting.prompt, byIndex(answers)));
        taken = true;
      }
      return taken;
    }
    const reply = message.trim();
    const first = this.waiting.values().next().value;
    if (!reply || !first) return false;
    first.settle(answered(first.prompt, [reply]));
    return true;
  }

  /**
   * A message that reaches the session (a turn's input or a steer): an
   * approval a relayed prompt waited for is noted, so the same request is
   * allowed once. The message still goes to Codex.
   */
  observe(message: string): void {
    if (this.to !== "parent") return;
    const relayed = relayedApprovals.get(this.sessionId);
    if (!relayed?.asked.size) return;
    for (const reply of parseAgentQuestionReply(message) ?? []) {
      const key = relayed.asked.get(nativeItemId(reply.itemId));
      if (!key) continue;
      relayed.asked.delete(nativeItemId(reply.itemId));
      if (approvesAnswer(reply.answer)) relayed.approved.add(key);
    }
  }

  /**
   * Codex resolved a request itself (its turn ended): it waits no more,
   * and it takes no response.
   */
  resolved(requestId: unknown): void {
    for (const waiting of [...this.waiting.values()])
      if (waiting.requestId === requestId)
        waiting.lapse({ result: codexNoResponse });
  }

  /** The turn or the process ends: nothing waits any more. */
  close(): void {
    for (const waiting of [...this.waiting.values()])
      waiting.lapse({ result: waiting.prompt.decline });
  }
}

function byIndex(replies: AgentQuestionReply[]): string[] {
  const answers: string[] = [];
  for (const reply of replies) answers[reply.index] = reply.answer;
  return Array.from(answers, (answer) => answer ?? "");
}

/** A waiting prompt's outcome from the person's answers. */
function answered(prompt: CodexPrompt, answers: string[]): CodexPromptAnswer {
  if (!prompt.approvalKey) return { result: prompt.accept(answers) };
  if (approvesAnswer(answers[0] ?? ""))
    return { result: prompt.accept(answers) };
  return {
    result: prompt.decline,
    note: notes.denied(prompt.what, denialReason(answers[0] ?? "")),
  };
}
