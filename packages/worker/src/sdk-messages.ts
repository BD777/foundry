/**
 * Claude Agent SDK message parsing and translation.
 *
 * Pure functions that convert raw SDK messages into UI process events
 * and extract text/metadata. No side effects, no cli.ts dependencies.
 */

import { claudeRequestUsage, claudeSubagentUsage } from "./turn-usage.js";
import type {
  AgentSessionEvent,
  AgentSessionEventMetadata,
  TranscriptMessage,
} from "@bd777/foundry-protocol";
import { processDetails, processLabels } from "@bd777/foundry-protocol";

export class ClaudeAgentTurnError extends Error {
  readonly subtype: string;

  constructor(subtype: string, message: string) {
    super(message);
    this.name = "ClaudeAgentTurnError";
    this.subtype = subtype;
  }
}

/**
 * A result the harness produced for a background task notification without
 * running the model (for example a task stopped with the previous process,
 * replayed on resume). It answers no input, so it must not settle one.
 */
export function claudeTaskNotificationBookkeeping(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  const origin = record.origin as Record<string, unknown> | undefined;
  return (
    record.type === "result" &&
    origin?.kind === "task-notification" &&
    record.num_turns === 0
  );
}

/**
 * Where Claude Code's command queue has one of the inputs it was sent
 * (`command_lifecycle`, not in the SDK typings): queued behind other work,
 * started (from then on the stream answers it, even when it joined a turn
 * Claude was already running), or completed. Absent from older CLIs.
 */
export function claudeCommandLifecycle(
  message: unknown,
): { commandId: string; state: string } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.type !== "command_lifecycle") return undefined;
  const commandId = sdkString(record.command_uuid);
  const state = sdkString(record.state);
  return commandId && state ? { commandId, state } : undefined;
}

/** Who a result answered: "task-notification" for Claude's own follow-up. */
export function claudeResultOrigin(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.type !== "result") return undefined;
  const origin = record.origin as Record<string, unknown> | undefined;
  return sdkString(origin?.kind) || undefined;
}

/**
 * A synthetic assistant message the CLI emits when the API rejects the turn
 * before any real response (e.g. 401 or an overlong prompt). It carries
 * `model: "<synthetic>"`, zero usage, an `error` code, and a `stop_reason`
 * placeholder such as "stop_sequence" — which is NOT the failure reason.
 */
export function claudeApiErrorMessage(
  message: unknown,
): { text: string; code: string } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (
    record.type !== "assistant" ||
    (record.is_api_error_message !== true && record.isApiErrorMessage !== true)
  ) {
    return undefined;
  }
  const inner =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : undefined;
  const text = inner
    ? claudeContentText(inner.content).trim()
    : sdkString(record.content);
  return {
    text,
    code:
      sdkString(record.error) || sdkString(inner?.stop_reason) || "api_error",
  };
}

/** Human-readable wording for terminal-reason codes the SDK reports. */
function terminalReasonLabel(reason: unknown): string {
  switch (sdkString(reason)) {
    case "api_error":
      return "The model API returned an error.";
    case "blocking_limit":
      return "The request exceeded the model context limit.";
    default:
      return "";
  }
}

export interface ClaudeProcessEvent {
  detail: string;
  label: string;
  level?: AgentSessionEvent["level"];
  metadata?: AgentSessionEventMetadata;
  message?: AgentSessionEvent["message"];
}

export type ClaudeTaskLifecycleChange =
  | { kind: "snapshot"; taskIds: string[] }
  | { kind: "started" | "settled"; taskId: string };

export function claudeAgentResultError(
  message: unknown,
): ClaudeAgentTurnError | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "result" || record.is_error !== true) {
    return undefined;
  }
  const subtype = sdkString(record.subtype) || "error_during_execution";
  const errors = Array.isArray(record.errors)
    ? record.errors.map((item) => sdkString(item)).filter(Boolean)
    : [];
  if (subtype === "error_max_turns") {
    const numTurns =
      typeof record.num_turns === "number" && Number.isFinite(record.num_turns)
        ? Math.max(1, Math.round(record.num_turns))
        : undefined;
    const turnLabel = numTurns ? ` (${numTurns})` : "";
    return new ClaudeAgentTurnError(
      subtype,
      `Claude reached the configured maximum number of turns${turnLabel}. Send "continue" to resume this chat from the same native session.`,
    );
  }
  // A failed turn carries no `errors` array for API-level rejections
  // (authentication_failed, invalid_request, …). Its real reason is the
  // synthetic `result` text; `stop_reason` is a placeholder ("stop_sequence")
  // and must never be shown as the failure. terminal_reason adds context when
  // the provider text is empty.
  const resultText = sdkString(record.result);
  const detail =
    errors.join("\n") ||
    resultText ||
    terminalReasonLabel(record.terminal_reason) ||
    sdkString(record.stop_reason) ||
    "Claude Agent SDK turn failed.";
  return new ClaudeAgentTurnError(subtype, detail);
}

export function claudeNativeSessionId(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const value = record.session_id ?? record.sessionId;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Extract the SDK task lifecycle independently from its UI projection.
 *
 * In streaming-input mode Claude may emit a successful `result` while
 * background tasks continue. Their later task notifications can wake Claude
 * for another model turn. Sessions judged on their answer (Issue work,
 * sessions other agents wait for) keep the turn until every started task
 * settles and a subsequent result arrives; a chat's turn ends with its
 * answer.
 */
export function claudeTaskLifecycleChange(
  message: unknown,
): ClaudeTaskLifecycleChange | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "system") {
    return undefined;
  }
  const subtype = sdkString(record.subtype);
  if (subtype === "background_tasks_changed") {
    if (!Array.isArray(record.tasks)) {
      return undefined;
    }
    return {
      kind: "snapshot",
      taskIds: record.tasks
        .map((task) =>
          task && typeof task === "object"
            ? sdkString((task as Record<string, unknown>).task_id)
            : "",
        )
        .filter(Boolean),
    };
  }
  const taskId = sdkString(record.task_id);
  if (!taskId) {
    return undefined;
  }
  if (subtype === "task_started") {
    return { kind: "started", taskId };
  }
  if (subtype === "task_notification") {
    return { kind: "settled", taskId };
  }
  return undefined;
}

export function isForwardedClaudeSubagentMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
  return (
    parentToolUseId !== undefined &&
    parentToolUseId !== null &&
    (typeof parentToolUseId !== "string" || parentToolUseId.trim() !== "")
  );
}

export function claudeMessageText(message: unknown): string {
  if (
    !message ||
    typeof message !== "object" ||
    isForwardedClaudeSubagentMessage(message)
  ) {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.type === "result") {
    return sdkString(record.result);
  }
  if (record.type === "assistant") {
    return claudeContentText(
      (record.message as Record<string, unknown> | undefined)?.content,
    );
  }
  if (record.type === "system") {
    if (record.subtype === "local_command_output") {
      return sdkString(record.content);
    }
    return "";
  }
  return "";
}

export function claudePartialText(message: unknown): string {
  if (
    !message ||
    typeof message !== "object" ||
    isForwardedClaudeSubagentMessage(message)
  ) {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.type !== "stream_event") {
    return "";
  }
  return claudeStreamEventText(record.event);
}

export function claudeProcessEvent(
  message: unknown,
): ClaudeProcessEvent | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    isForwardedClaudeSubagentMessage(message)
  ) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.type === "stream_event") {
    return claudeStreamProcessEvent(record.event);
  }
  const apiError = claudeApiErrorMessage(message);
  if (apiError) {
    return {
      label: processLabels.sessionFailed,
      detail: apiError.text || apiError.code,
      level: "error",
    };
  }
  if (record.type === "assistant") {
    const event = claudeAssistantProcessEvent(record.message);
    const requestUsage = claudeRequestUsage(message);
    if (event?.message && requestUsage)
      event.message.requestUsage = requestUsage;
    return event;
  }
  if (record.type === "tool_progress") {
    const name = sdkString(record.tool_name) || "tool";
    const elapsed =
      typeof record.elapsed_time_seconds === "number"
        ? ` · ${Math.round(record.elapsed_time_seconds)}s`
        : "";
    return { label: processLabels.usingTool, detail: `${name}${elapsed}` };
  }
  if (record.type === "tool_use_summary") {
    return {
      label: processLabels.usedTool,
      detail: sdkString(record.summary) || "Tool completed.",
    };
  }
  if (record.type === "system") {
    return claudeSystemProcessEvent(record);
  }
  if (record.type === "result" && record.is_error === true) {
    const errors = Array.isArray(record.errors)
      ? record.errors
          .map((item) => sdkString(item))
          .filter(Boolean)
          .join("\n")
      : "";
    return {
      label: processLabels.sessionFailed,
      detail:
        errors ||
        sdkString(record.result) ||
        terminalReasonLabel(record.terminal_reason) ||
        sdkString(record.stop_reason) ||
        "Claude Agent SDK turn failed.",
      level: "error",
    };
  }
  return undefined;
}

export function claudeSystemProcessEvent(
  record: Record<string, unknown>,
): ClaudeProcessEvent | undefined {
  const subtype = sdkString(record.subtype);
  switch (subtype) {
    case "init":
      return undefined;
    case "api_retry": {
      const positiveInteger = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
          ? value
          : undefined;
      const status = positiveInteger(record.error_status);
      const attempt = positiveInteger(record.attempt);
      const maximum = positiveInteger(record.max_retries);
      const delay =
        typeof record.retry_delay_ms === "number" &&
        Number.isFinite(record.retry_delay_ms) &&
        record.retry_delay_ms >= 0
          ? Math.ceil(record.retry_delay_ms / 1000)
          : undefined;
      // API error bodies may contain proxy diagnostics or private request data.
      // Project only structured retry metadata into shared Issue/Chat events.
      const detail = [
        status && status >= 100 && status <= 599
          ? `HTTP ${status}`
          : "Model request did not succeed yet",
        attempt
          ? `Retry ${attempt}${maximum ? `/${maximum}` : ""}`
          : "Retrying",
        delay !== undefined ? `continuing in ${delay}s` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        label:
          status === 429 ? processLabels.rateLimited : processLabels.modelRetry,
        detail,
        level: "warning",
      };
    }
    case "status":
      if (record.status === "requesting") {
        return {
          label: processLabels.requestingModel,
          detail: processDetails.claudeGenerating,
        };
      }
      if (record.status === "compacting") {
        return {
          label: processLabels.compactingContext,
          detail: processDetails.claudeCompacting,
        };
      }
      return undefined;
    case "task_started":
      return {
        label: processLabels.startingSubtask,
        detail: sdkString(record.description) || "Subtask started.",
        metadata: {
          prompt: sdkString(record.prompt) || undefined,
          subagentType: sdkString(record.subagent_type) || undefined,
          taskId: sdkString(record.task_id) || undefined,
          taskType: sdkString(record.task_type) || undefined,
          toolUseId: sdkString(record.tool_use_id) || undefined,
        },
      };
    case "task_progress":
      return {
        label: processLabels.subtaskRunning,
        detail:
          sdkString(record.summary) ||
          sdkString(record.description) ||
          "Subtask running.",
        metadata: {
          subagentType: sdkString(record.subagent_type) || undefined,
          subagentUsage: claudeSubagentUsage(record),
          taskId: sdkString(record.task_id) || undefined,
          taskType: sdkString(record.task_type) || undefined,
          toolUseId: sdkString(record.tool_use_id) || undefined,
        },
      };
    case "task_notification":
      const taskFailed = record.status !== "completed";
      return {
        label: taskFailed
          ? processLabels.subtaskFailed
          : processLabels.subtaskCompleted,
        detail: sdkString(record.summary) || "Subtask finished.",
        level: taskFailed ? "error" : "info",
        metadata: {
          taskOutputFile: sdkString(record.output_file) || undefined,
          subagentUsage: claudeSubagentUsage(record),
          taskId: sdkString(record.task_id) || undefined,
          taskType: sdkString(record.task_type) || undefined,
          toolUseId: sdkString(record.tool_use_id) || undefined,
        },
      };
    case "permission_denied":
      return {
        label: processLabels.permissionDenied,
        detail:
          sdkString(record.message) ||
          sdkString(record.tool_name) ||
          "Permission denied.",
        level: "warning",
      };
    case "notification":
      return {
        label: processLabels.notice,
        detail: sdkString(record.text) || "Claude notification.",
      };
    case "informational":
      return {
        label: processLabels.notice,
        detail: sdkString(record.content) || "Claude notification.",
        level: record.level === "warning" ? "warning" : "info",
      };
    default:
      return undefined;
  }
}

export function claudeAssistantProcessEvent(
  message: unknown,
): ClaudeProcessEvent | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const event = claudeContentBlockProcessEvent(block, true);
    if (event) {
      return event;
    }
  }
  return undefined;
}

export function claudeStreamProcessEvent(
  event: unknown,
): ClaudeProcessEvent | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const eventType = sdkString(record.type);
  if (eventType === "message_start") {
    return {
      label: processLabels.thinking,
      detail: processDetails.claudeProcessing,
    };
  }
  if (eventType === "content_block_start") {
    return claudeContentBlockProcessEvent(record.content_block, false);
  }
  if (eventType === "compaction_delta") {
    const detail =
      sdkString(record.content) || sdkString(record.delta) || "compacting";
    return { label: processLabels.compactingContext, detail };
  }
  return undefined;
}

export function claudeContentBlockProcessEvent(
  block: unknown,
  done: boolean,
): ClaudeProcessEvent | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  const type = sdkString(record.type);
  if (type === "tool_use" || type === "server_tool_use") {
    return {
      label: done ? processLabels.usedTool : processLabels.usingTool,
      detail: claudeToolUseDetail(record),
      message: {
        id: sdkString(record.id),
        kind: "tool",
        callId: sdkString(record.id) || undefined,
        status: done ? "completed" : "running",
        title: done ? processLabels.usedTool : processLabels.usingTool,
        text: claudeToolUseDetail(record),
      },
    };
  }
  if (type.includes("thinking")) {
    return {
      label: done ? processLabels.thought : processLabels.thinking,
      detail:
        sdkString(record.thinking) ||
        sdkString(record.text) ||
        processDetails.claudeThinking,
      message: {
        id: sdkString(record.id),
        kind: "reasoning",
        title: done ? processLabels.thought : processLabels.thinking,
        text:
          sdkString(record.thinking) ||
          sdkString(record.text) ||
          processDetails.claudeThinking,
      },
    };
  }
  return undefined;
}

export function claudeToolUseDetail(record: Record<string, unknown>): string {
  const name =
    sdkString(record.name) ||
    sdkString(record.tool_name) ||
    sdkString(record.id) ||
    "tool";
  if (!hasMeaningfulToolPayload(record.input)) {
    return name;
  }
  return `${name}\n\n\`\`\`json\n${truncateForEvent(safeJSONString(record.input), 1600)}\n\`\`\``;
}

export function claudeStreamEventText(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const record = event as Record<string, unknown>;
  const delta = record.delta;
  if (delta && typeof delta === "object") {
    const deltaRecord = delta as Record<string, unknown>;
    const deltaType = sdkString(deltaRecord.type);
    if (deltaType === "text_delta") {
      return typeof deltaRecord.text === "string" ? deltaRecord.text : "";
    }
  }
  const contentBlock = record.content_block;
  if (contentBlock && typeof contentBlock === "object") {
    const blockRecord = contentBlock as Record<string, unknown>;
    if (sdkString(blockRecord.type) === "text") {
      return typeof blockRecord.text === "string" ? blockRecord.text : "";
    }
  }
  return "";
}

export function claudeContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const record = block as Record<string, unknown>;
      if (sdkString(record.type) === "text") {
        return sdkString(record.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function sdkMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (record.type === "error") {
    return "";
  }
  if (record.type === "agent_message") {
    const value = record.text;
    return typeof value === "string" ? value.trim() : "";
  }
  if (typeof record.type === "string" && record.type !== "") {
    const item = record.item;
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "agent_message"
    ) {
      return sdkMessageText(item);
    }
    return "";
  }
  for (const key of ["finalResponse", "final_response", "result", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const parts = content.map((item) => sdkMessageText(item)).filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  const nested = record.message ?? record.item ?? record.data;
  if (nested && nested !== message) {
    return sdkMessageText(nested);
  }
  return "";
}

export function sdkResponseMessage(
  event: unknown,
  text: string,
): TranscriptMessage {
  const envelope =
    event && typeof event === "object"
      ? (event as Record<string, unknown>)
      : {};
  const item =
    envelope.item && typeof envelope.item === "object"
      ? (envelope.item as Record<string, unknown>)
      : envelope;
  return {
    id: sdkString(item.id),
    kind:
      item.phase === "commentary" || item.channel === "commentary"
        ? "commentary"
        : "assistant",
    text,
  };
}

function sdkProcessEventDetail(event: unknown): ClaudeProcessEvent | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const eventType = typeof record.type === "string" ? record.type : "";
  if (eventType === "turn.started") {
    return {
      label: processLabels.thinking,
      detail: processDetails.modelProcessing,
    };
  }
  if (eventType === "turn.completed") {
    return undefined;
  }
  if (eventType === "turn.failed" || eventType === "error") {
    const detail =
      sdkString(record.error) || sdkString(record.message) || "Turn failed.";
    return { label: processLabels.sessionFailed, detail, level: "error" };
  }
  if (!eventType.startsWith("item.")) {
    return undefined;
  }
  const item = record.item;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const itemRecord = item as Record<string, unknown>;
  const itemType = typeof itemRecord.type === "string" ? itemRecord.type : "";
  if (itemType === "agent_message") {
    return undefined;
  }
  const done = eventType === "item.completed";
  switch (itemType) {
    case "reasoning":
      return {
        label: done ? processLabels.thought : processLabels.thinking,
        detail: sdkString(itemRecord.text) || processDetails.modelThinking,
      };
    case "web_search":
      return {
        label: done ? processLabels.searched : processLabels.searching,
        detail: sdkString(itemRecord.query) || "Web search",
      };
    case "command_execution":
      return {
        label: done ? processLabels.ranCommand : processLabels.runningCommand,
        detail: sdkCommandDetail(itemRecord, done),
        level: itemRecord.status === "failed" ? "error" : "info",
      };
    case "mcp_tool_call":
      return {
        label: done ? processLabels.usedTool : processLabels.usingTool,
        detail: sdkToolCallDetail(itemRecord, done),
        level: itemRecord.status === "failed" ? "error" : "info",
      };
    case "file_change":
      return {
        label: done ? processLabels.editedFile : processLabels.editingFile,
        detail: sdkFileChangeDetail(itemRecord),
        level: itemRecord.status === "failed" ? "error" : "info",
      };
    case "todo_list":
      return {
        label: processLabels.updatedPlan,
        detail: sdkTodoListDetail(itemRecord),
      };
    case "error":
      return {
        label: processLabels.notice,
        detail: sdkString(itemRecord.message) || "Non-fatal SDK item.",
        level: "warning",
      };
    default:
      return {
        label: done
          ? processLabels.processedStep
          : processLabels.processingStep,
        detail: truncateForEvent(safeJSONString(itemRecord)),
      };
  }
}

/** Keep protocol semantics alongside the existing human-readable details. */
export function sdkProcessEvent(
  event: unknown,
): ClaudeProcessEvent | undefined {
  const detail = sdkProcessEventDetail(event);
  if (!detail) return undefined;
  const envelope = event as Record<string, unknown>;
  const item =
    envelope.item && typeof envelope.item === "object"
      ? (envelope.item as Record<string, unknown>)
      : {};
  const type = sdkString(item.type);
  return {
    ...detail,
    message: {
      id: sdkString(item.id),
      kind:
        type === "reasoning"
          ? "reasoning"
          : [
                "command_execution",
                "mcp_tool_call",
                "web_search",
                "file_change",
              ].includes(type)
            ? "tool"
            : "status",
      title: detail.label,
      text: detail.detail,
      callId:
        type !== "reasoning" ? sdkString(item.id) || undefined : undefined,
      status:
        item.status === "failed"
          ? "failed"
          : envelope.type === "item.completed"
            ? "completed"
            : "running",
    },
  };
}

export function sdkString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object" && "message" in value) {
    return sdkString((value as Record<string, unknown>).message);
  }
  return "";
}

export function sdkCommandDetail(
  item: Record<string, unknown>,
  includeOutput: boolean,
): string {
  const command = sdkString(item.command) || "command";
  const output = sdkString(item.aggregated_output);
  if (!includeOutput || output === "") {
    return command;
  }
  return `${command}\n\n\`\`\`\n${truncateForEvent(output)}\n\`\`\``;
}

export function sdkToolCallDetail(
  item: Record<string, unknown>,
  includeResult: boolean,
): string {
  const server = sdkString(item.server) || "mcp";
  const tool = sdkString(item.tool) || "tool";
  const parts = [`${server}.${tool}`];
  if (hasMeaningfulToolPayload(item.arguments)) {
    parts.push(
      `Arguments\n\n\`\`\`json\n${truncateForEvent(safeJSONString(item.arguments), 1600)}\n\`\`\``,
    );
  }
  if (includeResult && hasMeaningfulToolPayload(item.result)) {
    parts.push(
      `Result\n\n\`\`\`json\n${truncateForEvent(safeJSONString(item.result), 2400)}\n\`\`\``,
    );
  }
  if (item.error !== undefined) {
    parts.push(
      `Error\n\n${sdkString(item.error) || safeJSONString(item.error)}`,
    );
  }
  return parts.join("\n\n");
}

export function hasMeaningfulToolPayload(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return Boolean(trimmed && !/^(?:\{\}|\[\]|null|undefined)$/i.test(trimmed));
  }
  if (Array.isArray(value)) {
    return value.some(hasMeaningfulToolPayload);
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasMeaningfulToolPayload);
  }
  return true;
}

export function sdkFileChangeDetail(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    return "Files changed.";
  }
  return changes
    .map((change) => {
      if (!change || typeof change !== "object") {
        return "";
      }
      const record = change as Record<string, unknown>;
      return `- ${sdkString(record.kind) || "update"} ${sdkString(record.path) || "file"}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function sdkTodoListDetail(item: Record<string, unknown>): string {
  const items = Array.isArray(item.items) ? item.items : [];
  if (items.length === 0) {
    return "Plan updated.";
  }
  return items
    .map((todo) => {
      if (!todo || typeof todo !== "object") {
        return "";
      }
      const record = todo as Record<string, unknown>;
      const completed = record.completed === true ? "x" : " ";
      return `- [${completed}] ${sdkString(record.text) || "Step"}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function safeJSONString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncateForEvent(value: string, limit = 4000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n... truncated ...`;
}
