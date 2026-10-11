import { claudeTranscriptRecord } from "./transcript-adapters/claude.js";
import {
  maybeSubagentLine,
  readSubagentRecords,
  readTranscriptProjection,
  type TranscriptProjection,
} from "./subagent-records.js";
import { claudeRequestUsage, claudeSubagentUsage } from "./turn-usage.js";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sessionArtifactDirectories } from "./session-artifacts.js";
import {
  subagentResponseFingerprint,
  type AgentSubagentDigest,
  type AgentSubagentSummary,
  type AgentSubagentTranscript,
  type AgentSubagentTranscriptMessage,
  type SubagentUsage,
} from "@bd777/foundry-protocol";

const maxToolResultCharacters = 6000;
const maxTranscriptCharacters = 512 * 1024;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateToolResult(content: string): string {
  return content.length > maxToolResultCharacters
    ? `${content.slice(0, maxToolResultCharacters)}\n\n… tool output truncated`
    : content;
}

function messageContentBlocks(
  record: Record<string, unknown>,
): AgentSubagentTranscriptMessage[] {
  const requestUsage =
    record.type === "assistant" ? claudeRequestUsage(record) : undefined;
  return claudeTranscriptRecord(record, "message").map((item) => ({
    ...(requestUsage && item.kind !== "user" ? { requestUsage } : {}),
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
        ? `${message.content.slice(0, Math.max(0, remaining))}\n\n… conversation truncated`
        : message.content;
    target.push({ ...message, content });
    total += content.length;
  }
  return total;
}

/** The native message transcripts of a session's inputs, oldest first. */
function sessionTranscripts(
  workspacePath: string,
  sessionId: string,
): string[] {
  const sessionsRoot = resolve(workspacePath, ".foundry", "sessions");
  const relativePath = relative(sessionsRoot, resolve(sessionsRoot, sessionId));
  if (
    !sessionId.trim() ||
    relativePath.startsWith("..") ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("invalid subagent transcript target");
  }
  const transcripts = sessionArtifactDirectories(sessionsRoot, sessionId)
    .map((directory) => resolve(directory, "claude-sdk.messages.jsonl"))
    .filter((path) => existsSync(path));
  if (transcripts.length === 0) {
    throw new Error("subagent transcript is unavailable");
  }
  return transcripts;
}

/**
 * A session's native message records across all of its inputs, oldest
 * first, so a subagent is found whichever input started it.
 */
async function readSessionRecords(
  workspacePath: string,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const path of sessionTranscripts(workspacePath, sessionId))
    records.push(...(await readSubagentRecords(path)));
  return records;
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

function isSubagentStart(record: Record<string, unknown>): boolean {
  return (
    record.type === "system" &&
    record.subtype === "task_started" &&
    stringValue(record.task_type) === "local_agent" &&
    stringValue(record.task_id) !== "" &&
    stringValue(record.tool_use_id) !== ""
  );
}

function isTaskNotification(record: Record<string, unknown>): boolean {
  return record.type === "system" && record.subtype === "task_notification";
}

/** What a subagent's list entry says, before its answers are added. */
function subagentHeading(
  sessionId: string,
  started: {
    taskId: string;
    toolUseId: string;
    description: string;
    subagentType: string;
  },
  notification:
    | {
        status: AgentSubagentSummary["status"];
        summary: string;
        usage?: SubagentUsage;
      }
    | undefined,
): Omit<AgentSubagentSummary, "prompt" | "responseTexts"> {
  return {
    sessionId,
    status: notification?.status ?? "running",
    subagentType: started.subagentType || undefined,
    taskId: started.taskId,
    title: started.description || notification?.summary || "Subagent",
    toolUseId: started.toolUseId,
    ...(notification?.usage ? { usage: notification.usage } : {}),
  };
}

export async function listAgentSubagents(
  workspacePath: string,
  sessionId: string,
): Promise<AgentSubagentSummary[]> {
  const records = await readSessionRecords(workspacePath, sessionId);
  const notifications = new Map<string, Record<string, unknown>>();
  const responses = new Map<string, string[]>();
  for (const record of records) {
    if (isTaskNotification(record))
      notifications.set(stringValue(record.task_id), record);
    const parent = stringValue(record.parent_tool_use_id);
    if (parent) {
      const texts = assistantResponseTexts(record);
      if (texts.length)
        responses.set(parent, [...(responses.get(parent) ?? []), ...texts]);
    }
  }
  return records
    .filter(isSubagentStart)
    .map((started): AgentSubagentSummary => {
      const taskId = stringValue(started.task_id);
      const toolUseId = stringValue(started.tool_use_id);
      const notification = notifications.get(taskId);
      const prompt = stringValue(started.prompt);
      const heading = subagentHeading(
        sessionId,
        {
          taskId,
          toolUseId,
          description: stringValue(started.description),
          subagentType: stringValue(started.subagent_type),
        },
        notification && {
          status: taskStatus(notification),
          summary: stringValue(notification.summary),
          usage: claudeSubagentUsage(notification),
        },
      );
      return {
        prompt: prompt || undefined,
        responseTexts: [...new Set(responses.get(toolUseId) ?? [])],
        ...heading,
      };
    });
}

/** What the digest of a subagent list needs from one transcript line. */
type DigestPart =
  | {
      kind: "started";
      taskId: string;
      toolUseId: string;
      description: string;
      subagentType: string;
    }
  | {
      kind: "notification";
      taskId: string;
      status: AgentSubagentSummary["status"];
      summary: string;
      usage?: SubagentUsage;
    }
  | { kind: "answers"; toolUseId: string; fingerprints: string[] };

const assistantType = Buffer.from('"type":"assistant"');
const taskStartedSubtype = Buffer.from('"subtype":"task_started"');
const taskNotificationSubtype = Buffer.from('"subtype":"task_notification"');

function digestPart(
  line: Buffer,
): { value: DigestPart; bytes: number } | undefined {
  // A subagent's tool results and streamed deltas, most of its bytes, are
  // not needed: only its answers, starts and notifications are decoded.
  if (
    !maybeSubagentLine(line) ||
    !(
      line.includes(assistantType) ||
      line.includes(taskStartedSubtype) ||
      line.includes(taskNotificationSubtype)
    )
  )
    return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
  } catch {
    // An unfinished final JSON record will be retried on append.
    return undefined;
  }
  if (!record || typeof record !== "object") return undefined;
  let value: DigestPart | undefined;
  if (isSubagentStart(record))
    value = {
      kind: "started",
      taskId: stringValue(record.task_id),
      toolUseId: stringValue(record.tool_use_id),
      description: stringValue(record.description),
      subagentType: stringValue(record.subagent_type),
    };
  else if (isTaskNotification(record))
    value = {
      kind: "notification",
      taskId: stringValue(record.task_id),
      status: taskStatus(record),
      summary: stringValue(record.summary),
      usage: claudeSubagentUsage(record),
    };
  else if (stringValue(record.parent_tool_use_id)) {
    const fingerprints = assistantResponseTexts(record).map(
      subagentResponseFingerprint,
    );
    if (fingerprints.length)
      value = {
        kind: "answers",
        toolUseId: stringValue(record.parent_tool_use_id),
        fingerprints,
      };
  }
  return value
    ? { value, bytes: 64 + JSON.stringify(value).length }
    : undefined;
}

/**
 * Only what a digest shows is kept per transcript, so every input of a long
 * session stays cached and a digest reads only what was appended since.
 */
const subagentDigestParts: TranscriptProjection<DigestPart> = {
  name: "digest",
  select: digestPart,
  budgetBytes: 16 * 1024 * 1024,
  maxFiles: 4096,
};

/**
 * The session's subagents as a chat lists them (agentSubagentDigest of
 * listAgentSubagents), read from each transcript's cached digest parts.
 */
export async function listAgentSubagentDigests(
  workspacePath: string,
  sessionId: string,
): Promise<AgentSubagentDigest[]> {
  const parts: DigestPart[] = [];
  for (const path of sessionTranscripts(workspacePath, sessionId))
    parts.push(...(await readTranscriptProjection(path, subagentDigestParts)));
  const notifications = new Map<
    string,
    Extract<DigestPart, { kind: "notification" }>
  >();
  const answers = new Map<string, string[]>();
  for (const part of parts) {
    if (part.kind === "notification") notifications.set(part.taskId, part);
    else if (part.kind === "answers")
      answers.set(part.toolUseId, [
        ...(answers.get(part.toolUseId) ?? []),
        ...part.fingerprints,
      ]);
  }
  return parts.flatMap((part) =>
    part.kind === "started"
      ? [
          {
            ...subagentHeading(sessionId, part, notifications.get(part.taskId)),
            responseFingerprints: [
              ...new Set(answers.get(part.toolUseId) ?? []),
            ],
          },
        ]
      : [],
  );
}

/** The subagent as a chat lists it: answers as fingerprints, no prompt. */
export function agentSubagentDigest({
  prompt: _prompt,
  responseTexts,
  ...subagent
}: AgentSubagentSummary): AgentSubagentDigest {
  const fingerprints = responseTexts
    .filter((text) => text.trim() !== "")
    .map(subagentResponseFingerprint);
  return {
    ...subagent,
    responseFingerprints: [...new Set(fingerprints)],
  };
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
    ...(notification && claudeSubagentUsage(notification)
      ? { usage: claudeSubagentUsage(notification) }
      : {}),
  };
}
