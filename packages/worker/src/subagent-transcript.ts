import { claudeTranscriptRecord } from "./transcript-adapters/claude.js";
import { readSubagentRecords } from "./subagent-records.js";
import { relative, resolve } from "node:path";
import type {
  AgentSubagentSummary,
  AgentSubagentTranscript,
  AgentSubagentTranscriptMessage,
} from "@foundry/protocol";

const maxToolResultCharacters = 6000;
const maxTranscriptCharacters = 512 * 1024;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateToolResult(content: string): string {
  return content.length > maxToolResultCharacters
    ? `${content.slice(0, maxToolResultCharacters)}\n\n… 工具输出已截断`
    : content;
}

function messageContentBlocks(
  record: Record<string, unknown>,
): AgentSubagentTranscriptMessage[] {
  return claudeTranscriptRecord(record, "message").map((item) => ({
    id: item.id,
    kind: item.kind,
    role:
      item.kind === "user"
        ? "user"
        : item.kind === "tool"
          ? "tool"
          : "assistant",
    content: item.kind === "tool" ? truncateToolResult(item.text) : item.text,
    title: item.title,
    callId: item.callId,
    status: item.status,
  }));
}

function pushWithinLimit(
  target: AgentSubagentTranscriptMessage[],
  messages: AgentSubagentTranscriptMessage[],
  currentCharacters: number,
): number {
  let total = currentCharacters;
  for (const message of messages) {
    if (total >= maxTranscriptCharacters) {
      break;
    }
    const remaining = maxTranscriptCharacters - total;
    const content =
      message.content.length > remaining
        ? `${message.content.slice(0, Math.max(0, remaining))}\n\n… 对话已截断`
        : message.content;
    target.push({ ...message, content });
    total += content.length;
  }
  return total;
}

async function readSessionRecords(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const sessionsRoot = resolve(workspacePath, ".foundry", "sessions");
  const transcriptPath = resolve(
    sessionsRoot,
    sessionId,
    "claude-sdk.messages.jsonl",
  );
  const relativePath = relative(sessionsRoot, transcriptPath);
  if (
    !sessionId.trim() ||
    relativePath.startsWith("..") ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("invalid subagent transcript target");
  }
  return readSubagentRecords(transcriptPath);
}

function taskStatus(
  notification: Record<string, unknown> | undefined,
): AgentSubagentSummary["status"] {
  const status = notification ? stringValue(notification.status) : "";
  return status === "failed"
    ? "failed"
    : status === "completed"
      ? "completed"
      : status === "stopped"
        ? "failed"
        : "running";
}

function assistantResponseTexts(record: Record<string, unknown>): string[] {
  if (record.type !== "assistant") {
    return [];
  }
  const envelopeMessage = record.message;
  if (!envelopeMessage || typeof envelopeMessage !== "object") {
    return [];
  }
  const message = envelopeMessage as Record<string, unknown>;
  if (message.role !== "assistant") {
    return [];
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item): string[] => {
    if (typeof item === "string") {
      return item.trim() ? [item] : [];
    }
    if (!item || typeof item !== "object") {
      return [];
    }
    const block = item as Record<string, unknown>;
    const text = block.type === "text" ? stringValue(block.text) : "";
    return text.trim() ? [text] : [];
  });
}

export async function listAgentSubagents(
  workspacePath: string,
  sessionId: string,
): Promise<AgentSubagentSummary[]> {
  const records = await readSessionRecords(workspacePath, sessionId);
  return records
    .filter(
      (record) =>
        record.type === "system" &&
        record.subtype === "task_started" &&
        stringValue(record.task_type) === "local_agent" &&
        stringValue(record.task_id) !== "" &&
        stringValue(record.tool_use_id) !== "",
    )
    .map((started): AgentSubagentSummary => {
      const taskId = stringValue(started.task_id);
      const toolUseId = stringValue(started.tool_use_id);
      const notification = [...records]
        .reverse()
        .find(
          (record) =>
            record.type === "system" &&
            record.subtype === "task_notification" &&
            stringValue(record.task_id) === taskId,
        );
      const responseTexts = records
        .filter(
          (record) => stringValue(record.parent_tool_use_id) === toolUseId,
        )
        .flatMap(assistantResponseTexts)
        .filter((text, index, values) => values.indexOf(text) === index);
      const prompt = stringValue(started.prompt);
      return {
        prompt: prompt || undefined,
        responseTexts,
        sessionId,
        status: taskStatus(notification),
        subagentType: stringValue(started.subagent_type) || undefined,
        taskId,
        title:
          stringValue(started.description) ||
          stringValue(notification?.summary) ||
          "Subagent",
        toolUseId,
      };
    });
}

export async function readAgentSubagentTranscript(
  workspacePath: string,
  sessionId: string,
  taskId: string,
): Promise<AgentSubagentTranscript> {
  if (!taskId.trim()) {
    throw new Error("invalid subagent transcript target");
  }
  const records = await readSessionRecords(workspacePath, sessionId);
  const started = records.find(
    (record) =>
      record.type === "system" &&
      record.subtype === "task_started" &&
      stringValue(record.task_id) === taskId,
  );
  if (!started || stringValue(started.task_type) !== "local_agent") {
    throw new Error("subagent task was not found");
  }
  const toolUseId = stringValue(started.tool_use_id);
  if (!toolUseId) {
    throw new Error("subagent transcript has no tool identifier");
  }

  const notification = [...records]
    .reverse()
    .find(
      (record) =>
        record.type === "system" &&
        record.subtype === "task_notification" &&
        stringValue(record.task_id) === taskId,
    );
  const messages: AgentSubagentTranscriptMessage[] = [];
  let characterCount = 0;
  for (const record of records) {
    if (stringValue(record.parent_tool_use_id) !== toolUseId) {
      continue;
    }
    characterCount = pushWithinLimit(
      messages,
      messageContentBlocks(record),
      characterCount,
    );
    if (characterCount >= maxTranscriptCharacters) {
      break;
    }
  }
  const prompt = stringValue(started.prompt);
  if (
    prompt &&
    !messages.some(
      (message) => message.role === "user" && message.content === prompt,
    )
  ) {
    messages.unshift({ content: prompt, id: `${taskId}_prompt`, role: "user" });
  }
  return {
    messages,
    prompt: prompt || undefined,
    sessionId,
    status: taskStatus(notification),
    subagentType: stringValue(started.subagent_type) || undefined,
    taskId,
    title:
      stringValue(started.description) ||
      stringValue(notification?.summary) ||
      "Subagent",
    toolUseId,
  };
}
