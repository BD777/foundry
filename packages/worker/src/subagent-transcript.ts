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
import { string } from "./json-values.js";

const maxToolResultCharacters = 6000;
const maxTranscriptCharacters = 512 * 1024;

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

function taskStatus(
  notification: Record<string, unknown> | undefined,
): AgentSubagentSummary["status"] {
  const status = notification ? string(notification.status) : "";
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
    const text = block.type === "text" ? string(block.text) : "";
    return text.trim() ? [text] : [];
  });
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

/**
 * What a subagent list needs from one transcript line. A digest keeps no
 * prompt and its answers only as fingerprints; the whole list keeps both.
 * Every task's start is kept: a subagent's transcript is found by it.
 */
type ListPart =
  | {
      kind: "started";
      taskType: string;
      taskId: string;
      toolUseId: string;
      description: string;
      subagentType: string;
      prompt?: string;
    }
  | {
      kind: "notification";
      taskId: string;
      status: AgentSubagentSummary["status"];
      summary: string;
      usage?: SubagentUsage;
    }
  | { kind: "answers"; toolUseId: string; answers: string[] };

const assistantType = Buffer.from('"type":"assistant"');
const taskStartedSubtype = Buffer.from('"subtype":"task_started"');
const taskNotificationSubtype = Buffer.from('"subtype":"task_notification"');

function listPart(line: Buffer, digest: boolean): ListPart | undefined {
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
  if (record.type === "system" && record.subtype === "task_started")
    return {
      kind: "started",
      taskType: string(record.task_type),
      taskId: string(record.task_id),
      toolUseId: string(record.tool_use_id),
      description: string(record.description),
      subagentType: string(record.subagent_type),
      ...(digest ? {} : { prompt: string(record.prompt) }),
    };
  if (isTaskNotification(record))
    return {
      kind: "notification",
      taskId: string(record.task_id),
      status: taskStatus(record),
      summary: string(record.summary),
      usage: claudeSubagentUsage(record),
    };
  const toolUseId = string(record.parent_tool_use_id);
  if (!toolUseId) return undefined;
  const texts = assistantResponseTexts(record);
  if (!texts.length) return undefined;
  return {
    kind: "answers",
    toolUseId,
    answers: digest ? texts.map(subagentResponseFingerprint) : texts,
  };
}

/**
 * Only what a list shows is kept per transcript, so every input of a long
 * session stays cached and a list read reads only what was appended since.
 * Its full records would not fit: they are most of a long session's bytes.
 */
function listProjection(
  name: "digest" | "list",
  budgetBytes: number,
): TranscriptProjection<ListPart> {
  const digest = name === "digest";
  return {
    name,
    select: (line) => {
      const value = listPart(line, digest);
      return value
        ? { value, bytes: 64 + JSON.stringify(value).length }
        : undefined;
    },
    budgetBytes,
    maxFiles: 4096,
  };
}

const subagentDigestParts = listProjection("digest", 16 * 1024 * 1024);
const subagentListParts = listProjection("list", 32 * 1024 * 1024);

async function readListParts(
  paths: string[],
  projection: TranscriptProjection<ListPart>,
): Promise<ListPart[]> {
  const parts: ListPart[] = [];
  for (const path of paths)
    parts.push(...(await readTranscriptProjection(path, projection)));
  return parts;
}

/**
 * The session's subagents in the order they started, across its inputs,
 * each with its heading and its distinct answers as the projection keeps
 * them.
 */
async function readSubagentList(
  workspacePath: string,
  sessionId: string,
  projection: TranscriptProjection<ListPart>,
) {
  const parts = await readListParts(
    sessionTranscripts(workspacePath, sessionId),
    projection,
  );
  const notifications = new Map<
    string,
    Extract<ListPart, { kind: "notification" }>
  >();
  const answers = new Map<string, string[]>();
  for (const part of parts) {
    if (part.kind === "notification") notifications.set(part.taskId, part);
    else if (part.kind === "answers") {
      const held = answers.get(part.toolUseId);
      if (held) held.push(...part.answers);
      else answers.set(part.toolUseId, [...part.answers]);
    }
  }
  return parts.flatMap((part) =>
    part.kind === "started" &&
    part.taskType === "local_agent" &&
    part.taskId !== "" &&
    part.toolUseId !== ""
      ? [
          {
            prompt: part.prompt,
            heading: subagentHeading(
              sessionId,
              part,
              notifications.get(part.taskId),
            ),
            answers: [...new Set(answers.get(part.toolUseId) ?? [])],
          },
        ]
      : [],
  );
}

export async function listAgentSubagents(
  workspacePath: string,
  sessionId: string,
): Promise<AgentSubagentSummary[]> {
  return (
    await readSubagentList(workspacePath, sessionId, subagentListParts)
  ).map(({ prompt, heading, answers }) => ({
    prompt: prompt || undefined,
    responseTexts: answers,
    ...heading,
  }));
}

/**
 * The session's subagents as a chat lists them (agentSubagentDigest of
 * listAgentSubagents).
 */
export async function listAgentSubagentDigests(
  workspacePath: string,
  sessionId: string,
): Promise<AgentSubagentDigest[]> {
  return (
    await readSubagentList(workspacePath, sessionId, subagentDigestParts)
  ).map(({ heading, answers }) => ({
    ...heading,
    responseFingerprints: answers,
  }));
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

const parentToolUseKey = Buffer.from('"parent_tool_use_id":"');

/**
 * The tool uses a line names as a parent, read from its bytes without
 * decoding it: at least its record's parent_tool_use_id. An id that would
 * need unescaping is "*", any.
 */
function lineParents(line: Buffer): { value: string; bytes: number }[] {
  const parents: { value: string; bytes: number }[] = [];
  let at = line.indexOf(parentToolUseKey);
  while (at !== -1) {
    const start = at + parentToolUseKey.length;
    const end = line.indexOf(0x22, start);
    if (end === -1) break;
    const id = line.toString("utf8", start, end);
    const value = id.includes("\\") ? "*" : id;
    parents.push({ value, bytes: 64 + value.length });
    at = line.indexOf(parentToolUseKey, end);
  }
  return parents;
}

/**
 * The tool uses each transcript's records name as their parent, each once,
 * so opening a subagent reads only the inputs that hold its records.
 */
const subagentParents: TranscriptProjection<string> = {
  name: "parents",
  select: (line) => {
    const parents = lineParents(line);
    // A line naming several (one quoting another's) is kept whole.
    return parents.length === 1
      ? parents[0]
      : parents.length > 1
        ? { value: "*", bytes: 65 }
        : undefined;
  },
  budgetBytes: 16 * 1024 * 1024,
  maxFiles: 4096,
  distinct: true,
};

export async function readAgentSubagentTranscript(
  workspacePath: string,
  sessionId: string,
  taskId: string,
): Promise<AgentSubagentTranscript> {
  if (!taskId.trim()) {
    throw new Error("invalid subagent transcript target");
  }
  // The digests a chat read find the input the task started in and how it
  // ended; only the inputs holding the subagent's records are read whole.
  const paths = sessionTranscripts(workspacePath, sessionId);
  let startedIn: string | undefined;
  let notification: Extract<ListPart, { kind: "notification" }> | undefined;
  for (const path of paths)
    for (const part of await readTranscriptProjection(
      path,
      subagentDigestParts,
    )) {
      if (part.kind === "started" && part.taskId === taskId) startedIn ??= path;
      else if (part.kind === "notification" && part.taskId === taskId)
        notification = part;
    }
  const started =
    startedIn &&
    (await readSubagentRecords(startedIn)).find(
      (record) =>
        record.type === "system" &&
        record.subtype === "task_started" &&
        string(record.task_id) === taskId,
    );
  if (!started || string(started.task_type) !== "local_agent") {
    throw new Error("subagent task was not found");
  }
  const toolUseId = string(started.tool_use_id);
  if (!toolUseId) {
    throw new Error("subagent transcript has no tool identifier");
  }

  const records: Record<string, unknown>[] = [];
  for (const path of paths) {
    const parents = await readTranscriptProjection(path, subagentParents);
    if (parents.includes(toolUseId) || parents.includes("*"))
      records.push(...(await readSubagentRecords(path)));
  }
  const messages: AgentSubagentTranscriptMessage[] = [];
  let characterCount = 0;
  for (const record of records) {
    if (string(record.parent_tool_use_id) !== toolUseId) {
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
  const prompt = string(started.prompt);
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
    status: notification?.status ?? "running",
    subagentType: string(started.subagent_type) || undefined,
    taskId,
    title: string(started.description) || notification?.summary || "Subagent",
    toolUseId,
    ...(notification?.usage ? { usage: notification.usage } : {}),
  };
}
