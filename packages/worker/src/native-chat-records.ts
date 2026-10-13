// What a native Codex/Claude session log says, line by line: its recent
// exchanges and status, preview, handoff context and when it last moved.

import { createHash } from "node:crypto";
import type { ChatThread } from "@bd777/foundry-protocol";
import { optionalRecord, record, string } from "./json-values.js";

/** Lightweight answer identity and the latest two exchanges, not the log prefix. */
function clipNativeRecapText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= 1024) return text;
  const characters = Array.from(text);
  return `${characters.slice(0, 160).join("")}\n…\n${characters.slice(-80).join("")}`;
}

/**
 * A native turn only runs while its agent writes its session file. A turn
 * that started and then went silent this long was cut off (the process was
 * killed or the machine restarted) and never wrote its end.
 */
const nativeTurnSilenceMs = 30 * 60 * 1000;

/**
 * Records that are the conversation itself. Claude Code appends bookkeeping
 * (last-prompt, ai-title, cost-state, …) when an idle session closes; those
 * are not activity.
 */
function conversationRecord(
  record: Record<string, unknown> | undefined,
  provider: "codex" | "claude",
): boolean {
  return provider === "claude"
    ? record?.type === "user" || record?.type === "assistant"
    : record?.type === "response_item" || record?.type === "event_msg";
}

/**
 * When a native session's conversation last moved, from its records, never
 * the file's write time: idle sessions and `/resume` rewrite files without a
 * new turn. A file without any conversation (a `/resume` stub) is not a chat.
 */
export function conversationActivity(
  tailActivity: Date | undefined,
  headLines: string[],
  provider: "codex" | "claude",
): Date | undefined {
  return tailActivity ?? nativeChatRecap(headLines, provider).activityAt;
}

export function nativeChatRecap(
  lines: string[],
  provider: "codex" | "claude",
  lastWrite?: Date,
): Pick<ChatThread, "answerRevision" | "recentMessages" | "status"> & {
  /** When the conversation last moved: its latest message or step. */
  activityAt?: Date;
} {
  const messages: NonNullable<ChatThread["recentMessages"]> = [];
  let answerRevision: string | undefined;
  let status: ChatThread["status"];
  let activityAt: Date | undefined;
  for (const line of lines) {
    const record = parseJSONRecord(line);
    if (
      conversationRecord(record, provider) &&
      typeof record?.timestamp === "string"
    ) {
      const at = new Date(record.timestamp);
      if (Number.isFinite(at.getTime()) && (!activityAt || at > activityAt))
        activityAt = at;
    }
    const payload =
      record?.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : undefined;
    if (provider === "codex" && record?.type === "event_msg") {
      if (payload?.type === "task_started") status = "running";
      else if (payload?.type === "task_complete") status = "completed";
      else if (payload?.type === "turn_aborted") status = "canceled";
      else if (payload?.type === "error") status = "failed";
    }
    if (record?.type === "result")
      status = record.is_error ? "failed" : "completed";
    if (record?.isApiErrorMessage === true) status = "failed";
    const user = cleanSessionUserMessage(
      provider === "codex"
        ? eventUserMessage(record) || responseItemUserMessage(record)
        : claudeUserMessage(record),
    );
    const assistant =
      provider === "codex"
        ? responseItemAssistantMessage(record) || eventAssistantMessage(record)
        : claudeAssistantMessage(record);
    const text = user || assistant;
    if (!text) continue;
    const role = user ? "user" : "assistant";
    if (assistant)
      answerRevision = createHash("sha256").update(line).digest("hex");
    const previous = messages.at(-1);
    const clipped = clipNativeRecapText(text);
    if (previous?.role === role && previous.text === clipped) continue;
    if (previous?.role === "assistant" && role === "assistant") {
      const combined = previous.text + "\n\n" + clipped;
      previous.text = clipNativeRecapText(combined);
    } else messages.push({ role, text: clipped });
    while (messages.filter((message) => message.role === "user").length > 2)
      messages.shift();
  }
  if (
    status === "running" &&
    lastWrite &&
    Date.now() - lastWrite.getTime() > nativeTurnSilenceMs
  )
    status = "canceled";
  let start = messages.length;
  let users = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    start = index;
    if (messages[index]?.role === "user" && ++users === 2) break;
  }
  return {
    activityAt,
    answerRevision,
    recentMessages: messages.slice(start).slice(-8),
    status,
  };
}

export function codexSessionPreview(lines: string[]): string {
  for (const line of lines.slice(1, 80)) {
    const record = parseJSONRecord(line);
    const message = eventUserMessage(record) || responseItemUserMessage(record);
    const preview = firstUserAuthoredLine(cleanSessionUserMessage(message));
    if (preview) {
      return preview;
    }
  }
  return "";
}

export function claudeSessionPreview(lines: string[]): string {
  for (const line of lines.slice(0, 120)) {
    const record = parseJSONRecord(line);
    const message = claudeUserMessage(record);
    const preview = firstUserAuthoredLine(cleanSessionUserMessage(message));
    if (preview) {
      return preview;
    }
  }
  return "";
}

export function codexSessionHandoffContext(lines: string[]): string {
  const turns: string[] = [];
  for (const line of lines.slice(1)) {
    const record = parseJSONRecord(line);
    const user = cleanSessionUserMessage(
      eventUserMessage(record) || responseItemUserMessage(record),
    );
    if (user) {
      pushHandoffTurn(turns, `User: ${user}`);
      continue;
    }
    const assistant =
      responseItemAssistantMessage(record) || eventAssistantMessage(record);
    if (assistant) {
      pushHandoffTurn(turns, `Codex: ${assistant}`);
    }
    if (turns.join("\n\n").length > 12000) {
      break;
    }
  }
  return truncateHandoffContext(turns.join("\n\n"));
}

export function claudeSessionHandoffContext(lines: string[]): string {
  const turns: string[] = [];
  for (const line of lines) {
    const record = parseJSONRecord(line);
    const user = cleanSessionUserMessage(claudeUserMessage(record));
    if (user) {
      pushHandoffTurn(turns, `User: ${user}`);
      continue;
    }
    const assistant = claudeAssistantMessage(record);
    if (assistant) {
      pushHandoffTurn(turns, `Claude: ${assistant}`);
    }
    if (turns.join("\n\n").length > 12000) {
      break;
    }
  }
  return truncateHandoffContext(turns.join("\n\n"));
}

function pushHandoffTurn(turns: string[], turn: string): void {
  const normalized = turn.trim();
  if (!normalized || turns[turns.length - 1] === normalized) {
    return;
  }
  turns.push(normalized);
}

function truncateHandoffContext(value: string): string {
  const limit = 12000;
  const prefix = "Earlier context truncated.\n\n";
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  return `${prefix}${text.slice(-(limit - prefix.length))}`;
}

function cleanSessionUserMessage(message: string): string {
  const kept: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }
    if (
      isInjectedContextLine(trimmed) ||
      isFoundryRuntimeInstructionLine(trimmed)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function firstUserAuthoredLine(message: string): string {
  const lines = message.split(/\r?\n/);
  const firstMeaningful =
    lines.find((line) => line.trim() !== "")?.trim() ?? "";
  if (!firstMeaningful || isInjectedContextLine(firstMeaningful)) {
    return "";
  }
  return firstMeaningful.slice(0, 96);
}

function isInjectedContextLine(line: string): boolean {
  return (
    line.startsWith("<recommended_plugins>") ||
    line.startsWith("<environment_context>") ||
    line.startsWith("<apps_instructions>") ||
    line.startsWith("<plugins_instructions>") ||
    line.startsWith("<skills_instructions>") ||
    line.startsWith("<permissions instructions>") ||
    line.startsWith("<collaboration_mode>") ||
    line.startsWith("<INSTRUCTIONS>") ||
    line.startsWith("# AGENTS.md instructions") ||
    line.startsWith("# Personal Codex Profile")
  );
}

function isFoundryRuntimeInstructionLine(line: string): boolean {
  return line.startsWith("You are running through Foundry's local daemon");
}

export function parseJSONRecord(
  line: string,
): Record<string, unknown> | undefined {
  try {
    return optionalRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function eventUserMessage(record: Record<string, unknown> | undefined): string {
  if (
    record?.type !== "event_msg" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  return payload.type === "user_message" && typeof payload.message === "string"
    ? payload.message
    : "";
}

function responseItemUserMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "response_item" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.role !== "user" || !Array.isArray(payload.content)) {
    return "";
  }
  const parts = payload.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const content = item as Record<string, unknown>;
      return typeof content.text === "string" ? content.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n");
}

function responseItemAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "response_item" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.role !== "assistant" || !Array.isArray(payload.content)) {
    return "";
  }
  return messageContentText(payload.content);
}

function eventAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "event_msg" ||
    !record.payload ||
    typeof record.payload !== "object"
  ) {
    return "";
  }
  const payload = record.payload as Record<string, unknown>;
  return payload.type === "agent_message" && typeof payload.message === "string"
    ? payload.message.trim()
    : "";
}

function claudeUserMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "user" ||
    !record.message ||
    typeof record.message !== "object"
  ) {
    return "";
  }
  const message = record.message as Record<string, unknown>;
  if (message.role !== "user") {
    return "";
  }
  return messageContentText(message.content);
}

function claudeAssistantMessage(
  record: Record<string, unknown> | undefined,
): string {
  if (
    record?.type !== "assistant" ||
    !record.message ||
    typeof record.message !== "object"
  ) {
    return "";
  }
  const message = record.message as Record<string, unknown>;
  if (message.role !== "assistant") {
    return "";
  }
  return messageContentText(message.content);
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join("\n\n");
}
