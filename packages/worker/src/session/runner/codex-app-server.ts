import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { nativeSourcePaths } from "../../harness/native/native-runtime-paths.js";
import { archiveCodexThread } from "../chat/native-archive.js";
import { codexHistoryRequest } from "../chat/codex-history.js";
import { CodexNativeWork } from "../../native-work/codex.js";
import { registerNativeWorkController } from "../../native-work/types.js";
import { nativeCli } from "../../harness/native/native-cli.js";
import { authenticateIsolatedCodex } from "../../harness/agent-runtime/codex-auth.js";
import { acquireRuntime } from "../../harness/agent-runtime/maintenance.js";
import { codexModelCatalogArguments } from "../../harness/agent-runtime/codex-model-catalog.js";
import {
  recordWorkToolStarting,
  recordWorkToolCompleted,
  recordNativeWork,
} from "../../session-work/supervisor.js";
/** Codex threads backed by the shared native control client. */
import {
  CodexAppServer,
  type CodexRequestError,
} from "../../harness/agent-runtime/codex-client.js";
import {
  AsyncInputQueue,
  emitOutOfBandSessionEvent,
  reportNativeOwnTurn,
  type CodexSDKThread,
} from "../session-state.js";
import {
  processLabels,
  sessionEventLabels,
  type TranscriptMessage,
} from "@bd777/foundry-protocol";
import { CodexQuestionGate, codexRequestResolved } from "./codex-questions.js";
import { sdkMessageText, sdkResponseMessage } from "./sdk-messages.js";
import { codexTurnUsage, turnUsageMetadata } from "../usage/turn-usage.js";
import { CodexTimingTracker } from "../usage/codex-timing.js";
import { redactSecrets } from "../../platform/secret-redaction.js";
import { errorMessage } from "../../platform/utils.js";
import {
  codexGoalSnapshot,
  goalStateKey,
  goalSyncEvent,
  type SessionGoalAction,
} from "../goals.js";
export { CodexAppServer } from "../../harness/agent-runtime/codex-client.js";
export type { CodexRpcTimeouts } from "../../harness/agent-runtime/codex-client.js";

/** Resume preserves native history, including its original developer instructions.
 * Refresh only Foundry's trusted current configuration before any new user turn.
 * A failure deliberately aborts startup instead of running with a stale catalog.
 */
export async function refreshCodexInstructions(
  client: Pick<CodexAppServer, "request">,
  threadId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const text = config.developer_instructions;
  if (typeof text !== "string" || !text.trim()) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }],
      },
    ],
  });
}

/** Boundary mapping: the rest of Foundry continues consuming its native-event shape. */
export function appServerItem(item: any): Record<string, unknown> {
  const types: Record<string, string> = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    webSearch: "web_search",
  };
  return {
    ...item,
    type: types[item.type] ?? item.type,
    ...(item.type === "commandExecution"
      ? { aggregated_output: item.aggregatedOutput, exit_code: item.exitCode }
      : {}),
    ...(item.type === "reasoning"
      ? { text: [...(item.summary ?? []), ...(item.content ?? [])].join("\n") }
      : {}),
    ...(item.type === "fileChange"
      ? {
          changes: (item.changes ?? []).map((change: any) => ({
            ...change,
            kind:
              typeof change.kind === "object" ? change.kind.type : change.kind,
          })),
        }
      : {}),
  };
}

export function appServerInput(input: unknown): unknown[] {
  return (
    typeof input === "string"
      ? [{ type: "text", text: input }]
      : (input as any[])
  ).map((part) =>
    part.type === "local_image"
      ? { type: "localImage", path: part.path }
      : { ...part, text_elements: [] },
  );
}

/** Foundry state authorizes a turn; restore an externally archived native copy first. */
export async function resumeCodexThread(
  client: Pick<CodexAppServer, "request">,
  params: Record<string, unknown> & { threadId: string },
  env: NodeJS.ProcessEnv,
  onRestored?: () => void,
) {
  const home = nativeSourcePaths("codex", env).dataHome;
  if (
    existsSync(
      resolve(
        home,
        "archived_sessions",
        ".foundry-archive",
        `${params.threadId}.lock`,
      ),
    ) ||
    existsSync(
      resolve(
        home,
        "archived_sessions",
        ".foundry-archive",
        `${params.threadId}.json`,
      ),
    )
  ) {
    await archiveCodexThread(
      client,
      params.threadId,
      "active",
      env,
      undefined,
      30_000,
    );
    onRestored?.();
  }
  try {
    return await codexHistoryRequest(client, params, env);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("is archived"))
      throw error;
    const restored = await archiveCodexThread(
      client,
      params.threadId,
      "active",
      env,
      undefined,
      30_000,
    );
    if (restored === "not_found")
      await codexHistoryRequest(
        client,
        { threadId: params.threadId },
        env,
        "thread/unarchive",
      );
    onRestored?.();
    return codexHistoryRequest(client, params, env);
  }
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(
        ([key, item]) =>
          `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(item)}`,
      )
      .join(", ")}}`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Provider fields that name and route an endpoint but hold no credential. */
const processProviderFields = [
  "name",
  "base_url",
  "wire_api",
  "env_key",
  "requires_openai_auth",
  "supports_websockets",
  "websocket_connect_timeout_ms",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
];

/**
 * Codex 0.166 rejects `turn/start` (modelProviderMismatch) unless the thread's
 * provider is the app-server's own: a provider chosen only in the
 * thread/start or thread/resume `config` leaves the process on `openai`.
 * The process therefore starts on the same provider. Its command line is
 * readable by other local users, so it declares the provider without
 * credentials (headers, query parameters, tokens, a URL's userinfo or query);
 * the complete definition still reaches Codex only in the thread `config`,
 * which takes precedence for requests.
 */
export function codexProviderArguments(
  config: Record<string, unknown>,
): string[] {
  const provider = config.model_provider;
  if (typeof provider !== "string" || !provider) return [];
  const definition = (
    config.model_providers as Record<string, unknown> | undefined
  )?.[provider] as Record<string, unknown> | undefined;
  const declared = Object.fromEntries(
    processProviderFields
      .filter((field) => definition?.[field] !== undefined)
      .map((field) => {
        const value = definition![field];
        if (field !== "base_url" || typeof value !== "string")
          return [field, value];
        try {
          const url = new URL(value);
          return [field, `${url.origin}${url.pathname}`];
        } catch {
          return [field, value];
        }
      }),
  );
  return [
    "-c",
    `model_provider=${tomlValue(provider)}`,
    ...(definition
      ? ["-c", `model_providers.${provider}=${tomlValue(declared)}`]
      : []),
  ];
}

/**
 * Codex 0.166 pins a thread to the provider it started on: resuming it under
 * another one is refused with one of these. A fork carries the history to the
 * current provider; older Codex resumed under the new provider in place.
 */
export function codexProviderChanged(error: unknown): boolean {
  const type = (error as CodexRequestError | undefined)?.codexErrorType;
  return (
    type === "modelProviderMismatch" || type === "modelProviderNotConfigured"
  );
}

export const codexProviderForkNotice =
  "This conversation's model provider changed. Codex keeps a thread on the provider it started with, so Foundry continued the conversation, with its history, in a new Codex thread.";

/** Codex 0.164 reports an endpoint's context-length refusal with this code. */
export function codexContextWindowExceeded(error: unknown): boolean {
  const value = error as
    { codexErrorInfo?: unknown; message?: unknown } | null | undefined;
  return (
    value?.codexErrorInfo === "contextWindowExceeded" ||
    (typeof value?.message === "string" &&
      value.message.includes("ran out of room in the model's context window"))
  );
}

export const codexCompactionNotice =
  "The model's context window is full. Foundry is compacting this thread with Codex's own compaction and will continue once.";

/**
 * The input of the one continuation after compaction. The person's message is
 * already in the thread (Codex records it before sampling and keeps it through
 * compaction), so it is not sent a second time.
 */
export const codexCompactionContinuation =
  "Foundry compacted this thread because the model's context window was full. Continue the most recent request from where it stopped.";

/** How often a goal's progress alone (tokens, time) is published. */
const codexGoalProgressMs = 30_000;

/** Codex's goal for a thread, as thread/goal/get and thread/goal/updated report it. */
export interface CodexThreadGoal {
  objective: string;
  /** active, paused, blocked, usageLimited, budgetLimited or complete (0.167). */
  status: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  timeUsedSeconds?: number;
}

function codexGoal(value: any): CodexThreadGoal | null {
  if (!value || typeof value !== "object" || typeof value.status !== "string")
    return null;
  return {
    objective: typeof value.objective === "string" ? value.objective : "",
    status: value.status,
    tokensUsed: value.tokensUsed,
    tokenBudget: value.tokenBudget,
    timeUsedSeconds: value.timeUsedSeconds,
  };
}

/** What a thread's app-server still runs once a Foundry turn has ended. */
export interface CodexNativeActivity {
  closed?: boolean;
  goalStatus?: string;
  liveTerminals: number;
  queued: number;
  ownTurn: boolean;
}

/**
 * Whether the thread's app-server still works on its own. A goal's
 * auto-continuation, background terminals and queued inputs live in that
 * process only: closing it would end them.
 */
export function codexNativeActivityBusy(
  activity: CodexNativeActivity,
): boolean {
  return (
    !activity.closed &&
    (activity.ownTurn ||
      activity.goalStatus === "active" ||
      activity.liveTerminals > 0 ||
      activity.queued > 0)
  );
}

/** A turn Codex started by itself while no Foundry turn was open. */
interface CodexOwnTurn {
  turnId: string;
  startedAt: number;
  response: string;
  usage?: Record<string, number>;
  usageBaseline?: CodexTokenUsage;
  usageSummed?: CodexTokenUsage;
}

interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

const emptyCodexTokenUsage: CodexTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

const codexToolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);

function codexTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const count = (field: string): number => {
    const number = usage[field];
    return typeof number === "number" && Number.isFinite(number) && number > 0
      ? Math.round(number)
      : 0;
  };
  return {
    inputTokens: count("inputTokens"),
    cachedInputTokens: count("cachedInputTokens"),
    cacheWriteInputTokens: count("cacheWriteInputTokens"),
    outputTokens: count("outputTokens"),
    reasoningOutputTokens: count("reasoningOutputTokens"),
    totalTokens: count("totalTokens"),
  };
}

function addCodexTokenUsage(
  left: CodexTokenUsage,
  right: CodexTokenUsage,
): CodexTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function subtractCodexTokenUsage(
  total: CodexTokenUsage,
  baseline: CodexTokenUsage,
): CodexTokenUsage {
  const delta = (key: keyof CodexTokenUsage) =>
    Math.max(0, total[key] - baseline[key]);
  return {
    inputTokens: delta("inputTokens"),
    cachedInputTokens: delta("cachedInputTokens"),
    cacheWriteInputTokens: delta("cacheWriteInputTokens"),
    outputTokens: delta("outputTokens"),
    reasoningOutputTokens: delta("reasoningOutputTokens"),
    totalTokens: delta("totalTokens"),
  };
}

function codexTokenUsageWire(usage: CodexTokenUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
  };
}

/** One app-server process and what Codex runs in it for this thread. */
interface CodexConnection {
  client: CodexAppServer;
  nativeWork?: CodexNativeWork;
  unregisterWork: () => void;
  /** Undefined until read; null when the thread has no goal. */
  goal?: CodexThreadGoal | null;
  goalRead?: Promise<void>;
  /** Inputs waiting in Codex's own queue (thread/queue/list). */
  queued: number;
  /** The queue read a thread/queue/changed started, while in flight. */
  queueRead?: Promise<void>;
  /** Command executions started and not completed, by item id. */
  openCommands: Map<string, number>;
  own?: CodexOwnTurn;
  /**
   * Own-turn notifications that arrived while a Foundry turn/start was
   * unanswered: Codex may have steered it into that turn.
   */
  held?: [string, any][];
  /** Kept open past the end of the Foundry turn that started it. */
  resident: boolean;
  /** The latest cumulative token usage Codex reported for the thread. */
  tokenUsageTotal?: CodexTokenUsage;
  /** Goal controls of the person in flight: they keep it open. */
  controls?: number;
  closing?: Promise<void>;
}

interface CodexFoundryTurn {
  client: CodexAppServer;
  turnId: string;
  terminal: boolean;
  completed: boolean;
  onNotification?: (method: string, params: any) => void;
  /** Shows a prompt of Codex's (a question card) in the turn. */
  onPrompt?: (message: TranscriptMessage) => void;
  /** A prompt stopped waiting without an answer. */
  onPromptSettled?: (itemId: string) => void;
  /** An item of the turn, as Codex last reported it. */
  item?: (itemId: string) => Record<string, unknown> | undefined;
  onFailure?: (error: Error) => void;
  onDiagnostic?: (message: string) => void;
}

/**
 * A thread handle keeps identity between turns; each turn has one native
 * owner. With `persistent`, the app-server stays open after a completed
 * turn while Codex still works on its own (codexNativeActivityBusy), and the
 * turns it starts by itself are published to the session; otherwise, and
 * once that work ends, it closes as soon as the turn does.
 */
export class CodexAppServerThread implements CodexSDKThread {
  id?: string;
  private starting = false;
  private active?: CodexFoundryTurn;
  private connection?: CodexConnection;
  private shutDown = false;
  /** The goal state last published (goalStateKey), and when. */
  private goalKey = "";
  private goalSent = "";
  private goalSentAt = 0;
  private goalTimer?: ReturnType<typeof setTimeout>;
  /** Codex's approvals, questions and elicitations (sessionQuestionsTo). */
  private readonly questions: CodexQuestionGate;
  constructor(
    private readonly command: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly config: Record<string, unknown>,
    private readonly options: Record<string, any>,
    id?: string,
  ) {
    this.id = id;
    this.questions = new CodexQuestionGate(
      options.questionsTo,
      String(options.workSessionId ?? env.FOUNDRY_SESSION_ID ?? ""),
      options.questionWaitMs,
    );
  }

  /**
   * The person's message while a prompt waits: its answer (or its reply
   * instead of a choice). False when it is a message for Codex.
   */
  answerQuestion(message: string): boolean {
    return this.questions.take(message);
  }

  /** A message to the session: it may grant a relayed approval. */
  observeInput(message: string): void {
    this.questions.observe(message);
  }

  async steer(input: unknown, inputId?: string): Promise<void> {
    const active = this.active;
    if (!active || active.terminal || !active.turnId)
      throw new Error("Codex is not accepting input for an active turn.");
    await active.client.request("turn/steer", {
      threadId: this.id,
      expectedTurnId: active.turnId,
      input: appServerInput(input),
      ...(inputId ? { clientUserMessageId: inputId } : {}),
    });
  }

  async run(): Promise<never> {
    throw new Error("Codex app-server requires event streaming.");
  }

  /** Whether a Foundry turn runs, or the kept process still works. */
  isBusy(): boolean {
    const connection = this.connection;
    return (
      Boolean(this.active) ||
      Boolean(
        connection?.resident &&
        codexNativeActivityBusy(this.activity(connection)),
      )
    );
  }

  /**
   * What Codex runs in the kept process: the data a later protocol field
   * (session state or a session-work row) would carry. Undefined when no
   * process is kept.
   */
  nativeActivity():
    | (CodexNativeActivity & {
        goal?: CodexThreadGoal | null;
        ownTurnId?: string;
      })
    | undefined {
    const connection = this.connection;
    if (!connection?.resident) return undefined;
    return {
      ...this.activity(connection),
      goal: connection.goal,
      ownTurnId: connection.own?.turnId,
    };
  }

  /**
   * The person pauses, resumes or clears Codex's goal (thread/goal/set,
   * thread/goal/clear, as the user). A thread without a process opens one
   * for it; the process stays while Codex then works on the goal.
   */
  async controlGoal(action: SessionGoalAction): Promise<void> {
    if (!this.id)
      throw new Error(
        "This Codex thread has not started yet, so it has no goal.",
      );
    const connection = await this.goalConnection();
    try {
      // The answer is the goal as it now is; its notification may come
      // after it, or not before this process is reconsidered.
      if (action === "clear") {
        await connection.client.request("thread/goal/clear", {
          threadId: this.id,
          origin: "user",
        });
        connection.goal = null;
        this.publishGoal(null);
      } else {
        const result = await connection.client.request("thread/goal/set", {
          threadId: this.id,
          status: action === "pause" ? "paused" : "active",
          origin: "user",
        });
        if (result?.goal) {
          connection.goal = codexGoal(result.goal);
          this.publishGoal(result.goal);
        }
      }
      this.log(
        "goal control",
        `${action} → ${connection.goal?.status ?? "none"}`,
      );
    } finally {
      connection.controls = (connection.controls ?? 1) - 1;
      this.reconsider(connection);
    }
  }

  /** The process a goal control goes to: the turn's, the kept one, or a new one. */
  private async goalConnection(): Promise<CodexConnection> {
    const held = (connection: CodexConnection) => {
      connection.controls = (connection.controls ?? 0) + 1;
      return connection;
    };
    if (this.active && this.connection?.client === this.active.client)
      return held(this.connection);
    if (this.starting)
      throw new Error(
        "A Codex turn is starting on this thread; try again in a moment.",
      );
    if (this.connection?.closing) await this.connection.closing;
    if (this.connection?.resident && !this.connection.closing)
      return held(this.connection);
    if (this.shutDown)
      throw new Error(
        "Foundry closed this Codex thread; send the chat a message to open it again.",
      );
    this.starting = true;
    let releaseRuntime = () => {};
    try {
      releaseRuntime = await acquireRuntime("codex");
      const catalogArgs = await codexModelCatalogArguments(
        this.command,
        this.env,
        this.options.workingDirectory,
        this.options.contextWindow,
      );
      const connection = held(
        this.connect(
          new CodexAppServer(
            this.command,
            this.env,
            this.options.workingDirectory,
            this.options.rpcTimeouts,
            [...catalogArgs, ...codexProviderArguments(this.config)],
          ),
        ),
      );
      try {
        // Notices of the resume (an unarchive, a fork) have no turn to show in.
        await this.openThread(connection, new AsyncInputQueue<unknown>());
      } catch (error) {
        await this.closeConnection(connection).catch(() => undefined);
        throw error;
      }
      connection.resident = true;
      this.log("opened for goal control", this.describe(connection));
      return connection;
    } finally {
      releaseRuntime();
      this.starting = false;
    }
  }

  /**
   * Publishes the thread's goal: at once when it is set, changes status or
   * is cleared; its progress (tokens, time) at most every 30 s.
   */
  private publishGoal(goal: unknown): void {
    const sessionId = String(this.options.workSessionId ?? "");
    if (!sessionId) return;
    const snapshot = codexGoalSnapshot(goal);
    const key = goalStateKey(snapshot);
    clearTimeout(this.goalTimer);
    this.goalTimer = undefined;
    // A thread that never had a goal says nothing.
    if (key === "none" && (this.goalKey === "" || this.goalKey === "none")) {
      this.goalKey = key;
      return;
    }
    const sent = JSON.stringify(snapshot);
    if (sent === this.goalSent) return;
    const send = () => {
      this.goalTimer = undefined;
      this.goalKey = key;
      this.goalSent = sent;
      this.goalSentAt = Date.now();
      emitOutOfBandSessionEvent(sessionId, goalSyncEvent(snapshot));
    };
    const wait = this.goalSentAt + codexGoalProgressMs - Date.now();
    if (key !== this.goalKey || wait <= 0) return send();
    this.goalTimer = setTimeout(send, wait);
    this.goalTimer.unref?.();
  }

  /** Ends a kept process; a turn in progress closes it when it ends. */
  async close(): Promise<void> {
    this.shutDown = true;
    const connection = this.connection;
    if (connection && this.active?.client !== connection.client)
      await this.closeConnection(
        connection,
        new Error("Foundry closed the Codex process."),
      );
  }

  async runStreamed(
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ events: AsyncIterable<unknown> }> {
    if (this.active || this.starting)
      throw new Error("A Codex turn is already running on this thread.");
    this.starting = true;
    let releaseRuntime = () => {};
    let connection: CodexConnection;
    let reused = false;
    try {
      // Runtime update validation already holds the maintenance gate.
      if (!this.options.runtimeGateHeld)
        releaseRuntime = await acquireRuntime(
          "codex",
          options?.signal as AbortSignal | undefined,
        );
      // One process writes the thread: an earlier one confirms its exit first.
      if (this.connection?.closing) await this.connection.closing;
      if (this.connection?.resident) {
        connection = this.connection;
        connection.resident = false;
        reused = true;
      } else {
        if (
          this.options.contextWindow &&
          this.options.contextWindow.model !== this.options.model
        )
          throw new Error(
            "Codex context window does not match the selected model.",
          );
        const catalogArgs = await codexModelCatalogArguments(
          this.command,
          this.env,
          this.options.workingDirectory,
          this.options.contextWindow,
          options?.signal as AbortSignal | undefined,
        );
        connection = this.connect(
          new CodexAppServer(
            this.command,
            this.env,
            this.options.workingDirectory,
            this.options.rpcTimeouts,
            [...catalogArgs, ...codexProviderArguments(this.config)],
          ),
        );
      }
    } catch (error) {
      releaseRuntime();
      throw error;
    } finally {
      this.starting = false;
    }
    const client = connection.client;
    const turnStartedAt =
      typeof options?.turnStartedAt === "number"
        ? options.turnStartedAt
        : undefined;
    const timing = new CodexTimingTracker({ startedAt: turnStartedAt });
    const active: CodexFoundryTurn = {
      client,
      turnId: "",
      terminal: false,
      completed: false,
    };
    this.active = active;
    const startupNotice = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          (
            options?.onStartupWait as (() => void | Promise<void>) | undefined
          )?.(),
        )
        .catch(() => undefined);
    }, 30_000);
    const queue = new AsyncInputQueue<unknown>();
    let failure: Error | undefined;
    let usage: any;
    let usageBaseline = connection.tokenUsageTotal;
    let summedUsage = { ...emptyCodexTokenUsage };
    let requestStartedAt = turnStartedAt ?? Date.now();
    let requestSequence = 0;
    const items = new Map<string, any>();
    // Codex 0.164 neither compacts nor retries after the endpoint refuses a
    // request as too long, and its next turns skip pre-turn compaction too
    // (the refusal leaves its active-context estimate near zero). Compact
    // natively once and continue; never drop history (DEV-061).
    let recovery: "none" | "compacting" | "continuing" = "none";
    const signal = options?.signal as AbortSignal | undefined;
    // Codex's native structured output: the turn's final message is
    // generated to this JSON Schema (TurnStartParams.outputSchema).
    const outputSchema = options?.outputSchema as
      Record<string, unknown> | undefined;
    const fail = (message: string) => {
      if (active.terminal) return;
      active.terminal = true;
      queue.push({
        type: "turn.failed",
        ...(usage ? { usage } : {}),
        timing: timing.finish(undefined),
        error: { message },
      });
      queue.close();
    };
    const abort = () => {
      if (active.terminal) return;
      // Interrupt the exact turn; closing the process is the bounded fallback.
      if (active.turnId)
        void client
          .request("turn/interrupt", {
            threadId: this.id,
            turnId: active.turnId,
          })
          .catch(() => undefined);
      active.terminal = true;
      failure = Object.assign(new Error("Codex turn was interrupted."), {
        ...(usage ? { usage } : {}),
        timing: timing.finish(undefined),
      });
      queue.close();
      if (!active.turnId) void client.close().catch(() => {});
    };
    active.onDiagnostic = (message) => {
      // Closing the client rejects an inventory request still in flight.
      // Its late diagnostic must not write to the completed turn's queue.
      if (active.terminal) return;
      queue.push({
        type: "item.completed",
        item: { id: "native_work_discovery", type: "error", message },
      });
    };
    active.onFailure = (error) => {
      if (!active.terminal)
        failure = Object.assign(error, {
          ...(usage ? { usage } : {}),
          timing: timing.finish(undefined),
        });
      queue.close();
    };
    active.onPrompt = (message) => {
      if (!active.terminal) queue.push({ type: "foundry.question", message });
    };
    active.onPromptSettled = (itemId) => {
      if (!active.terminal)
        queue.push({ type: "foundry.question_settled", itemId });
      else this.promptSettledOutOfBand(itemId);
    };
    active.item = (itemId) => items.get(itemId);
    active.onNotification = (method, params) => {
      if (method === "turn/started") {
        active.turnId = params.turn.id;
        requestStartedAt = Date.now();
      }
      if (params.turnId && active.turnId && params.turnId !== active.turnId)
        return;
      timing.observe(method, params);
      if (
        method === "thread/compacted" ||
        (method === "item/completed" &&
          params.item?.type === "contextCompaction")
      ) {
        // A compaction Foundry asked for is followed by its continuation.
        if (recovery === "compacting") return;
      }
      if (method === "thread/tokenUsage/updated") {
        const at = Date.now();
        const last = codexTokenUsage(params.tokenUsage?.last);
        const total = codexTokenUsage(params.tokenUsage?.total);
        if (last) {
          summedUsage = addCodexTokenUsage(summedUsage, last);
          requestSequence += 1;
          const requestId = `${active.turnId || params.turnId || "turn"}:${requestSequence}`;
          queue.push({
            type: "foundry.model_request_usage",
            requestUsage: {
              requestId,
              inputTokens: last.inputTokens,
              cacheReadTokens: last.cachedInputTokens,
              cacheWriteTokens: last.cacheWriteInputTokens,
              outputTokens: last.outputTokens,
              requestMs: Math.max(0, Math.round(at - requestStartedAt)),
              timingEstimated: true,
            },
          });
        }
        if (total) {
          if (!usageBaseline && last)
            usageBaseline = subtractCodexTokenUsage(total, last);
          usage = codexTokenUsageWire(
            usageBaseline
              ? subtractCodexTokenUsage(total, usageBaseline)
              : summedUsage,
          );
          connection.tokenUsageTotal = total;
        } else {
          usage = codexTokenUsageWire(summedUsage);
        }
        requestStartedAt = at;
      }
      if (method === "item/started" || method === "item/completed") {
        if (params.item.type === "commandExecution") {
          if (method === "item/started")
            recordWorkToolStarting(
              this.env.FOUNDRY_SESSION_ID || "",
              params.item.id,
            );
          else recordWorkToolCompleted(params.item.id);
        }
        // Foundry already records the person's input. Native echoes include
        // injected execution instructions and are not a second UI message.
        // The echo of a steered message says the model took it in (DEV-057).
        if (params.item.type === "userMessage") {
          if (method === "item/started" && params.item.clientId)
            queue.push({
              type: "foundry.input_consumed",
              clientId: params.item.clientId,
            });
          return;
        }
        const item = appServerItem(params.item);
        items.set(params.item.id, item);
        queue.push({
          type: method === "item/started" ? "item.started" : "item.completed",
          item,
        });
        if (
          method === "item/completed" &&
          codexToolItemTypes.has(params.item.type)
        )
          requestStartedAt = Date.now();
      }
      if (method === "item/agentMessage/delta") {
        const item = items.get(params.itemId) ?? {
          id: params.itemId,
          type: "agent_message",
          text: "",
        };
        item.text = String(item.text ?? "") + params.delta;
        items.set(params.itemId, item);
        queue.push({ type: "item.updated", item: { ...item } });
      }
      if (method === "turn/completed") {
        if (active.turnId && params.turn.id !== active.turnId) return;
        if (
          recovery === "none" &&
          params.turn.status === "failed" &&
          codexContextWindowExceeded(params.turn.error)
        ) {
          recovery = "compacting";
          active.turnId = "";
          queue.push({
            type: "item.completed",
            item: {
              id: "context_window_compaction",
              type: "agent_message",
              text: codexCompactionNotice,
              phase: "commentary",
            },
          });
          void client
            .request("thread/compact/start", { threadId: this.id })
            .catch((error) =>
              fail(
                `${params.turn.error?.message ?? "Codex ran out of room in the model's context window."} Compaction could not start: ${String(error)}`,
              ),
            );
          return;
        }
        if (recovery === "compacting") {
          if (params.turn.status !== "completed")
            return fail(
              `Codex ran out of room in the model's context window, and compacting the thread did not complete: ${params.turn.error?.message ?? params.turn.status}`,
            );
          recovery = "continuing";
          active.turnId = "";
          void client
            .request("turn/start", {
              threadId: this.id,
              input: appServerInput(codexCompactionContinuation),
              effort: this.options.modelReasoningEffort,
              ...(outputSchema ? { outputSchema } : {}),
              ...(this.options.modelSpeed === "fast"
                ? { serviceTier: "fast" }
                : {}),
            })
            .then((result) => {
              if (!active.terminal && !active.turnId)
                active.turnId = result.turn.id;
            })
            .catch((error) =>
              fail(
                `Codex compacted the thread but could not continue: ${String(error)}`,
              ),
            );
          return;
        }
        active.terminal = true;
        active.completed = params.turn.status === "completed";
        queue.push(
          params.turn.status === "completed"
            ? {
                type: "turn.completed",
                usage,
                timing: timing.finish(params.turn),
              }
            : {
                type: "turn.failed",
                ...(usage ? { usage } : {}),
                timing: timing.finish(params.turn),
                error: {
                  message:
                    params.turn.error?.message ??
                    `Codex turn ${params.turn.status}`,
                },
              },
        );
        queue.close();
      }
    };
    const cleanup = async () => {
      active.terminal = true;
      // A prompt of the turn no longer waits once the turn ended.
      this.questions.close();
      clearTimeout(startupNotice);
      signal?.removeEventListener("abort", abort);
      if (
        this.active === active &&
        active.completed &&
        (await this.keepsWorking(connection))
      ) {
        connection.resident = true;
        releaseRuntime();
        this.active = undefined;
        this.log("kept", this.describe(connection));
        return;
      }
      // Keep ownership and the runtime pinned until shutdown is confirmed.
      // A failed close must not make this handle available for another turn.
      await this.closeConnection(connection);
      releaseRuntime();
      if (this.active === active) this.active = undefined;
    };
    try {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      if (!reused) await this.openThread(connection, queue);
      clearTimeout(startupNotice);
      queue.push({ type: "thread.started", thread_id: this.id });
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      if (connection.own) connection.held = [];
      let result: any;
      try {
        result = await client.request("turn/start", {
          threadId: this.id,
          input: appServerInput(input),
          effort: this.options.modelReasoningEffort,
          ...(this.options.modelSpeed === "fast"
            ? { serviceTier: "fast" }
            : {}),
          ...(outputSchema ? { outputSchema } : {}),
        });
      } finally {
        const held = connection.held ?? [];
        connection.held = undefined;
        // Codex steers a turn/start into the turn it already runs: the turn
        // it started on its own continues as this Foundry turn, which then
        // answers it. Otherwise its events stay its own.
        const handedOver = Boolean(
          result && connection.own?.turnId === result.turn.id,
        );
        if (result) active.turnId = result.turn.id;
        if (handedOver) this.finishOwnTurn(connection, undefined, true);
        for (const [method, params] of held)
          if (handedOver) active.onNotification?.(method, params);
          else this.ownTurnEvent(connection, method, params);
      }
      return {
        events: (async function* () {
          try {
            for await (const event of queue) yield event;
            if (failure) throw failure;
          } finally {
            await cleanup();
          }
        })(),
      };
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new Error(
          `${String(error)}; cleanup also failed: ${String(cleanupError)}`,
          {
            cause: error,
          },
        );
      }
      if (signal?.aborted) throw new Error("Codex turn was interrupted.");
      throw error;
    }
  }

  /** Starts or resumes the native thread in a new process. */
  private async openThread(
    connection: CodexConnection,
    queue: AsyncInputQueue<unknown>,
  ): Promise<void> {
    const client = connection.client;
    await authenticateIsolatedCodex(client, this.env, this.command);
    const params = {
      cwd: this.options.workingDirectory,
      model: this.options.model,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      config: this.config,
      ...(this.options.ephemeral ? { ephemeral: true } : {}),
    };
    const resumed = Boolean(this.id);
    const thread = this.id
      ? await resumeCodexThread(
          client,
          { ...params, threadId: this.id },
          this.env,
          () =>
            queue.push({
              type: "item.completed",
              item: {
                id: "native_unarchive",
                type: "agent_message",
                text: "Codex had this thread archived; Foundry restored it.",
                phase: "commentary",
              },
            }),
        ).catch(async (error) => {
          if (!codexProviderChanged(error)) throw error;
          const fork = await client.request("thread/fork", {
            ...params,
            threadId: this.id,
          });
          queue.push({
            type: "item.completed",
            item: {
              id: "native_provider_fork",
              type: "agent_message",
              text: codexProviderForkNotice,
              phase: "commentary",
            },
          });
          return fork;
        })
      : await client.request("thread/start", params);
    this.id = thread.thread.id;
    if (resumed) await refreshCodexInstructions(client, this.id!, this.config);
    const foundrySessionId = this.options.workSessionId as string | undefined;
    if (foundrySessionId && this.id) {
      const nativeWork = new CodexNativeWork(
        client,
        this.id,
        nativeCli("codex").version || "unknown",
        (task) => {
          recordNativeWork(foundrySessionId, task);
          this.reconsider(connection);
        },
        (message) => this.active?.onDiagnostic?.(message),
        () => this.reconsider(connection),
      );
      connection.nativeWork = nativeWork;
      connection.unregisterWork = registerNativeWorkController(
        foundrySessionId,
        nativeWork,
      );
      nativeWork.start();
    }
    if (this.persistent())
      // thread/goal/updated keeps it current from here; a Codex without
      // goals refuses the read, which leaves the thread without one.
      connection.goalRead = client
        .request("thread/goal/get", { threadId: this.id })
        .then(
          (result) => {
            if (connection.goal !== undefined) return;
            connection.goal = codexGoal(result?.goal);
            this.publishGoal(result?.goal);
          },
          () => {
            if (connection.goal === undefined) connection.goal = null;
          },
        );
  }

  /** Whether a kept process may run beyond Foundry's turns. */
  private persistent(): boolean {
    return Boolean(
      this.options.persistent && this.options.workSessionId && !this.shutDown,
    );
  }

  private connect(client: CodexAppServer): CodexConnection {
    const connection: CodexConnection = {
      client,
      unregisterWork: () => {},
      queued: 0,
      openCommands: new Map(),
      resident: false,
    };
    client.onNotification = (method, params) =>
      this.dispatch(connection, method, params);
    client.onServerRequest = (method, params, requestId) =>
      CodexQuestionGate.handles(method)
        ? this.answerPrompt(connection, method, params, requestId)
        : undefined;
    client.onFailure = (error) => {
      const active = this.active;
      if (active?.client === client) active.onFailure?.(error);
      else if (connection.resident)
        void this.closeConnection(connection, error).catch(() => undefined);
    };
    this.connection = connection;
    return connection;
  }

  /**
   * Routes a notification: to the Foundry turn it belongs to, else to the
   * turn Codex runs on its own.
   */
  private dispatch(
    connection: CodexConnection,
    method: string,
    params: any,
  ): void {
    connection.nativeWork?.observe(method, params);
    if (params.threadId && this.id && params.threadId !== this.id) return;
    if (method === codexRequestResolved) {
      this.questions.resolved(params.requestId);
      return;
    }
    this.observeThread(connection, method, params);
    const active = this.active;
    const inTurn =
      active !== undefined &&
      active.client === connection.client &&
      !active.terminal;
    const turnId = params.turnId ?? params.turn?.id;
    if (connection.own && (!inTurn || turnId === connection.own.turnId)) {
      if (connection.held) return void connection.held.push([method, params]);
      return this.ownTurnEvent(connection, method, params);
    }
    if (inTurn) return active.onNotification?.(method, params);
    this.ownTurnEvent(connection, method, params);
  }

  /**
   * Answers a prompt of Codex's (codex-questions.ts). It is shown in the
   * Foundry turn it belongs to; one that comes in a turn Codex runs on its
   * own has no one following it and is declined.
   */
  private async answerPrompt(
    connection: CodexConnection,
    method: string,
    params: any,
    requestId: unknown,
  ): Promise<unknown> {
    const active = this.active;
    const turn =
      active &&
      active.client === connection.client &&
      !active.terminal &&
      (!params.turnId || !active.turnId || params.turnId === active.turnId)
        ? active
        : undefined;
    const { result, note } = await this.questions.answer(
      method,
      params,
      requestId,
      {
        show: turn ? (message) => turn.onPrompt?.(message) : undefined,
        settled: (itemId) =>
          turn
            ? turn.onPromptSettled?.(itemId)
            : this.promptSettledOutOfBand(itemId),
        item: (itemId) => turn?.item?.(itemId),
      },
    );
    const turnId = String(params.turnId ?? turn?.turnId ?? "");
    // After the response: the decline lets the turn continue to read it.
    if (note && turnId)
      setImmediate(() => {
        if (connection.closing) return;
        void connection.client
          .request("turn/steer", {
            threadId: this.id,
            expectedTurnId: turnId,
            input: appServerInput(note),
          })
          .catch((error) =>
            this.log("prompt note not delivered", errorMessage(error)),
          );
      });
    const outcome = result as {
      decision?: unknown;
      action?: unknown;
      answers?: Record<string, unknown>;
    };
    this.log(
      "prompt answered",
      `${method} ${JSON.stringify(outcome?.decision ?? outcome?.action ?? (outcome?.answers ? `${Object.keys(outcome.answers).length} answers` : "-"))}${note ? " with a note" : ""}`,
    );
    return result;
  }

  /** A prompt's end the turn can no longer report. */
  private promptSettledOutOfBand(itemId: string): void {
    const sessionId = String(this.options.workSessionId ?? "");
    if (sessionId)
      emitOutOfBandSessionEvent(sessionId, {
        label: sessionEventLabels.questionSettled,
        detail: itemId,
      });
  }

  /** Thread state that decides whether the process is still needed. */
  private observeThread(
    connection: CodexConnection,
    method: string,
    params: any,
  ): void {
    if (params.item?.type === "commandExecution") {
      if (method === "item/started")
        connection.openCommands.set(params.item.id, Date.now());
      if (method === "item/completed")
        connection.openCommands.delete(params.item.id);
    }
    if (method === "thread/goal/updated") {
      const before = connection.goal?.status;
      connection.goal = codexGoal(params.goal);
      if (connection.goal?.status !== before)
        this.log("goal", connection.goal?.status ?? "none");
      this.publishGoal(params.goal);
      this.reconsider(connection);
    }
    if (method === "thread/goal/cleared") {
      connection.goal = null;
      this.log("goal", "cleared");
      this.publishGoal(null);
      this.reconsider(connection);
    }
    if (method === "thread/queue/changed" && this.persistent()) {
      const read = this.readQueue(connection).finally(() => {
        if (connection.queueRead === read) connection.queueRead = undefined;
      });
      connection.queueRead = read;
    }
  }

  private async readQueue(connection: CodexConnection): Promise<void> {
    try {
      const page = await connection.client.request("thread/queue/list", {
        threadId: this.id,
        limit: 1,
      });
      if (Array.isArray(page?.data))
        connection.queued = page.data.length + (page.nextCursor ? 1 : 0);
    } catch {
      // The process closed, or this Codex has no queue: keep what was known.
    }
    this.reconsider(connection);
  }

  /** A notification no Foundry turn owns: a turn Codex runs by itself. */
  private ownTurnEvent(
    connection: CodexConnection,
    method: string,
    params: any,
  ): void {
    const sessionId = this.options.workSessionId as string | undefined;
    if (!sessionId || !this.persistent()) return;
    if (method === "turn/started") {
      if (connection.own) return;
      connection.own = {
        turnId: String(params.turn?.id ?? ""),
        startedAt: Date.now(),
        response: "",
        usageBaseline: connection.tokenUsageTotal,
        usageSummed: { ...emptyCodexTokenUsage },
      };
      reportNativeOwnTurn(sessionId, true);
      this.log("own turn started", connection.own.turnId);
      return;
    }
    const own = connection.own;
    if (!own) return;
    if (
      method === "thread/tokenUsage/updated" &&
      (params.tokenUsage?.last || params.tokenUsage?.total)
    ) {
      const last = codexTokenUsage(params.tokenUsage?.last);
      const total = codexTokenUsage(params.tokenUsage?.total);
      if (last)
        own.usageSummed = addCodexTokenUsage(
          own.usageSummed ?? emptyCodexTokenUsage,
          last,
        );
      if (total) {
        own.usageBaseline ??=
          last && total
            ? subtractCodexTokenUsage(total, last)
            : connection.tokenUsageTotal;
        own.usage = codexTokenUsageWire(
          own.usageBaseline
            ? subtractCodexTokenUsage(total, own.usageBaseline)
            : (own.usageSummed ?? emptyCodexTokenUsage),
        );
        connection.tokenUsageTotal = total;
      } else if (last) {
        own.usage = codexTokenUsageWire(
          own.usageSummed ?? emptyCodexTokenUsage,
        );
      }
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const event = {
        type: "item.completed",
        item: appServerItem(params.item),
      };
      const text = sdkMessageText(event);
      if (!text) return;
      const message = sdkResponseMessage(event, text);
      if (message.kind === "commentary")
        emitOutOfBandSessionEvent(sessionId, {
          label: processLabels.commentary,
          detail: text,
          message,
        });
      else own.response = text;
    }
    if (method === "turn/completed")
      this.finishOwnTurn(connection, params.turn);
  }

  /**
   * Publishes a turn Codex ran by itself once it ends, as Claude's own
   * turns are (finishClaudeContinuation): a divider and the answer.
   */
  private finishOwnTurn(
    connection: CodexConnection,
    turn: { status?: string; error?: { message?: string } } | undefined,
    handedOver = false,
  ): void {
    const own = connection.own;
    if (!own) return;
    connection.own = undefined;
    const sessionId = String(this.options.workSessionId ?? "");
    reportNativeOwnTurn(sessionId, false);
    this.log(
      "own turn ended",
      `${own.turnId} ${handedOver ? "continued as a Foundry turn" : (turn?.status ?? "-")}`,
    );
    if (handedOver) return;
    const failed = turn?.status !== "completed";
    if (failed || own.response) {
      const objective = connection.goal?.objective?.trim();
      // A later protocol field (timerFire origin "goal", or the goal itself)
      // would let the transcript tell a goal's turn from a background one.
      const prompt = redactSecrets(
        objective
          ? `Codex continued toward its goal: ${objective}`
          : "Codex continued on its own.",
      ).slice(0, 2000);
      const answer = failed
        ? (turn?.error?.message ?? `Codex turn ${turn?.status ?? "ended"}`)
        : own.response;
      emitOutOfBandSessionEvent(sessionId, {
        label: processLabels.backgroundTurn,
        detail: prompt,
        level: failed ? "error" : "info",
        metadata: {
          timerFire: {
            origin: "background",
            prompt,
            response: answer,
            startedAt: new Date(own.startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          ...turnUsageMetadata(
            codexTurnUsage({ usage: own.usage }),
            own.startedAt,
            failed ? "failed" : "completed",
          ),
        },
      });
    }
    this.reconsider(connection);
  }

  private activity(connection: CodexConnection): CodexNativeActivity {
    // A command no later inventory lists has ended, reported or not.
    const scan = connection.nativeWork?.lastScan();
    if (scan)
      for (const [id, startedAt] of connection.openCommands)
        if (scan.startedAt > startedAt && !scan.itemIds.has(id))
          connection.openCommands.delete(id);
    const terminals = new Set([
      ...(connection.nativeWork?.liveTerminalItemIds() ?? []),
      ...connection.openCommands.keys(),
    ]);
    return {
      closed: Boolean(connection.closing),
      goalStatus: connection.goal?.status,
      liveTerminals: terminals.size,
      queued: connection.queued,
      ownTurn: Boolean(connection.own),
    };
  }

  private describe(connection: CodexConnection): string {
    const activity = this.activity(connection);
    return `goal=${activity.goalStatus ?? "none"} terminals=${activity.liveTerminals} queued=${activity.queued} ownTurn=${activity.ownTurn}`;
  }

  /** At a completed turn's end: whether Codex still works in this process. */
  private async keepsWorking(connection: CodexConnection): Promise<boolean> {
    if (!this.persistent() || !this.id || connection.closing) return false;
    // A terminal started just before the turn ended may predate the last
    // inventory; read it once more when this Codex answers inventories.
    // A queue change or the goal read still in flight is awaited too.
    const pending = [
      ...(connection.nativeWork?.lastScan()
        ? [connection.nativeWork.refresh()]
        : []),
      ...(connection.queueRead ? [connection.queueRead] : []),
      ...(connection.goal === undefined && connection.goalRead
        ? [connection.goalRead]
        : []),
    ];
    if (pending.length)
      await Promise.race([
        Promise.all(pending),
        new Promise((done) => setTimeout(done, 2_000).unref?.()),
      ]);
    return codexNativeActivityBusy(this.activity(connection));
  }

  /** Between Foundry turns: closes the kept process once its work ended. */
  private reconsider(connection: CodexConnection): void {
    if (!connection.resident || connection.closing || connection.controls)
      return;
    if (this.active?.client === connection.client) return;
    if (codexNativeActivityBusy(this.activity(connection))) return;
    void this.closeConnection(
      connection,
      new Error("Codex finished the work it ran on its own."),
    ).catch(() => undefined);
  }

  private closeConnection(
    connection: CodexConnection,
    reason: unknown = new Error("The Codex turn ended."),
  ): Promise<void> {
    connection.closing ??= (async () => {
      const resident = connection.resident;
      connection.resident = false;
      await connection.client.close();
      connection.nativeWork?.closedAfterExit();
      connection.unregisterWork();
      if (connection.own)
        this.finishOwnTurn(connection, {
          status: "interrupted",
          error: {
            message: `The Codex process ended before this turn finished: ${errorMessage(reason)}`,
          },
        });
      if (this.connection === connection) this.connection = undefined;
      if (resident) this.log("closed", errorMessage(reason));
    })();
    return connection.closing;
  }

  private log(event: string, detail = ""): void {
    console.error(
      `${new Date().toISOString()} [codex-runtime] ${event} native=${this.id ?? "-"} session=${this.options.workSessionId ?? "-"}${detail ? `: ${redactSecrets(detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
    );
  }
}
