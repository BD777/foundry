import {
  sessionInputEventLabel,
  type AgentSession,
  type ChatThread,
  type WorkerRuntimeId,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import {
  displayProcessLabel,
  isProcessLabel,
  type ProcessLabelKey,
} from "../../lib/process-labels";
import {
  agentSessionHasStreamedResponse,
  agentSessionMessageText,
  agentSessionStatusLabel,
  agentSessionTerminalError,
} from "./chat-session-model";
import type { ChatSessionThread, ChatViewMessage } from "./chat-types";
import {
  legacyTranscriptEntries,
  sessionTranscriptEntries,
} from "./transcript-adapters";
import {
  projectTranscript,
  type TranscriptEntry,
} from "./transcript-projection";

export * from "./chat-session-model";
export * from "./chat-types";

function stableMessageTextHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function chatMessages(chat: ChatThread | undefined): ChatViewMessage[] {
  if (!chat) {
    return [];
  }

  if (chat.transcript?.length) {
    const entries = chat.transcript.flatMap((message): TranscriptEntry[] => {
      if (message.kind === "user") {
        return legacyTranscriptEntries(
          transcriptDisplayMessages({
            chat,
            role: "user",
            text: message.text,
          }).map((entry) => ({ ...entry, at: message.at })),
          `chat:${chat.id}:${message.id}`,
        );
      }
      return [
        {
          ...message,
          id: `chat:${chat.id}:${message.id}`,
          ...(message.turnUsage ? { usage: message.turnUsage } : {}),
          runtime: chat.provider,
          agentLabel: chat.profileLabel,
          text: message.text,
          title:
            message.title ??
            (message.kind === "reasoning"
              ? i18n.t("chat:transcript.reasoning")
              : message.kind === "commentary"
                ? i18n.t("chat:transcript.commentary")
                : undefined),
        },
      ];
    });
    return projectTranscript(entries);
  }

  const transcriptMessages = chatMessagesFromHandoffContext(chat);
  if (transcriptMessages.length > 0) {
    return projectTranscript(
      legacyTranscriptEntries(transcriptMessages, `chat:${chat.id}`),
    );
  }

  if (chat.preview) {
    return [
      {
        role: "user",
        text: chat.preview,
      },
    ];
  }

  return [
    {
      agentLabel: chat.profileLabel,
      role: "bot",
      runtime: chat.provider,
      statusLabel: i18n.t("chat:transcript.loaded"),
      text: i18n.t("chat:transcript.noTranscript"),
    },
  ];
}

function chatMessagesFromHandoffContext(chat: ChatThread): ChatViewMessage[] {
  const context = chat.handoffContext?.trim();
  if (!context) {
    return [];
  }
  const messages: ChatViewMessage[] = [];
  const marker = /^(User|Codex|Claude):\s*/;
  let currentRole: "user" | "bot" | undefined;
  let currentRuntime: Exclude<WorkerRuntimeId, "mock"> | undefined;
  let currentText: string[] = [];

  const flush = () => {
    const text = currentText.join("\n").trim();
    if (!currentRole || !text) {
      currentText = [];
      return;
    }
    messages.push(
      ...transcriptDisplayMessages({
        chat,
        role: currentRole,
        runtime: currentRuntime,
        text,
      }),
    );
    currentText = [];
  };

  for (const line of context.split(/\r?\n/)) {
    const match = line.match(marker);
    if (match) {
      flush();
      const speaker = match[1];
      currentRole = speaker === "User" ? "user" : "bot";
      currentRuntime =
        speaker === "Claude"
          ? "claude"
          : speaker === "Codex"
            ? "codex"
            : undefined;
      currentText.push(line.slice(match[0].length));
      continue;
    }
    if (!currentRole && line.trim()) {
      currentRole = "bot";
      currentRuntime = chat.provider;
    }
    currentText.push(line);
  }
  flush();
  return messages;
}

function transcriptDisplayMessages({
  chat,
  role,
  runtime,
  text,
}: {
  chat: ChatThread;
  role: "user" | "bot";
  runtime?: Exclude<WorkerRuntimeId, "mock">;
  text: string;
}): ChatViewMessage[] {
  const truncated = splitTruncatedTranscript(text);
  if (truncated) {
    const boundaryMessage: ChatViewMessage = {
      id: `chat:${chat.id}:truncated-boundary`,
      kind: "boundary",
      role: "bot",
      text: i18n.t("chat:transcript.truncated"),
    };
    if (!truncated.remaining) {
      return [boundaryMessage];
    }
    return [
      boundaryMessage,
      ...transcriptDisplayMessages({
        chat,
        role,
        runtime,
        text: truncated.remaining,
      }),
    ];
  }

  if (role === "bot") {
    // Native handoff turns already identify assistant messages. Their prose,
    // code fences, or quoted instructions are not evidence of a tool event or
    // context compaction. Only explicit process metadata should fold answers.
    return [
      {
        agentLabel: chat.profileLabel,
        role: "bot",
        runtime: runtime ?? chat.provider,
        text,
      },
    ];
  }

  const segments: ChatViewMessage[] = [];
  const pendingTools: ChatViewMessage[] = [];
  let remaining = text.trim();
  const skillInvocation = remaining.match(/^\[\$([^\]]+)]\(([^)]+)\)\s*/);
  if (skillInvocation) {
    remaining = remaining.slice(skillInvocation[0].length).trim();
    pendingTools.push(
      transcriptToolMessage(
        skillInvocation[0].trim(),
        i18n.t("chat:transcript.usedSkill", { name: skillInvocation[1] }),
      ),
    );
  }

  const annotatedPrompt = splitAnnotatedUserPrompt(remaining);
  if (annotatedPrompt) {
    pendingTools.push(transcriptToolMessage(annotatedPrompt.context));
    remaining = annotatedPrompt.request;
  }

  const contextIndex = firstFoldableTranscriptContextIndex(remaining);
  if (contextIndex === 0) {
    pendingTools.push(transcriptToolMessage(remaining));
    remaining = "";
  } else if (contextIndex > 0) {
    const visiblePrompt = remaining.slice(0, contextIndex).trim();
    const hiddenContext = remaining.slice(contextIndex).trim();
    if (visiblePrompt) {
      segments.push({ role: "user", text: visiblePrompt });
    }
    if (hiddenContext) {
      pendingTools.push(transcriptToolMessage(hiddenContext));
    }
    remaining = "";
  }

  if (remaining) {
    segments.push({ role: "user", text: remaining });
  }
  if (segments.length === 0 && pendingTools.length === 0 && text.trim()) {
    segments.push({ role: "user", text: text.trim() });
  }
  return [...segments, ...pendingTools];
}

function splitTruncatedTranscript(
  text: string,
): { remaining: string } | undefined {
  const match = text.match(/^Earlier context truncated\.?\s*/i);
  if (!match) {
    return undefined;
  }
  const remaining = text.slice(match[0].length).trim();
  if (!remaining) {
    return { remaining: "" };
  }
  const requestMarker = "## My request for Codex:";
  const requestIndex = remaining.indexOf(requestMarker);
  if (requestIndex >= 0) {
    return {
      remaining: remaining.slice(requestIndex + requestMarker.length).trim(),
    };
  }
  return { remaining };
}

function transcriptToolMessage(
  text: string,
  title = transcriptContextTitle(text),
): ChatViewMessage {
  return {
    id: `transcript-tool:${stableMessageTextHash(`${title}\n${text}`)}`,
    kind: "tool",
    role: "bot",
    text,
    title,
  };
}

function firstFoldableTranscriptContextIndex(text: string): number {
  if (!text.trim()) {
    return -1;
  }
  const markers = [
    "# Files mentioned by the user:",
    "# Response annotations:",
    "# AGENTS.md instructions",
    "# Personal Codex Profile",
    "<skill",
    "<environment_context",
    "<recommended_plugins",
    "<permissions instructions",
    "<apps_instructions",
    "<plugins_instructions",
    "<skills_instructions",
    "<collaboration_mode",
    "<app-context",
    "<developer_context",
    "::tool",
  ];
  const indexes = markers
    .flatMap((marker) => {
      const direct = text.indexOf(marker);
      const line = text.indexOf(`\n${marker}`);
      return [direct, line >= 0 ? line + 1 : -1];
    })
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function splitAnnotatedUserPrompt(
  text: string,
): { context: string; request: string } | undefined {
  const marker = "## My request for Codex:";
  const index = text.indexOf(marker);
  if (index <= 0) {
    return undefined;
  }
  const context = text.slice(0, index).trim();
  const request = text.slice(index + marker.length).trim();
  if (!context || firstFoldableTranscriptContextIndex(context) !== 0) {
    return undefined;
  }
  return { context, request };
}

function transcriptContextTitle(text: string): string {
  const skillName = text.match(/<name>([^<]+)<\/name>/)?.[1];
  if (skillName) {
    return i18n.t("chat:transcript.loadedSkill", { name: skillName });
  }
  if (text.includes("# Files mentioned by the user:")) {
    return i18n.t("chat:transcript.readFiles");
  }
  if (text.includes("# Response annotations:")) {
    return i18n.t("chat:transcript.readAnnotations");
  }
  if (
    text.includes("AGENTS.md instructions") ||
    text.includes("Personal Codex Profile")
  ) {
    return i18n.t("chat:transcript.readInstructions");
  }
  if (text.startsWith("<environment_context")) {
    return i18n.t("chat:transcript.readEnvironment");
  }
  if (text.startsWith("<recommended_plugins")) {
    return i18n.t("chat:transcript.readPlugins");
  }
  if (text.startsWith("<permissions instructions")) {
    return i18n.t("chat:transcript.readPermissions");
  }
  if (text.startsWith("<")) {
    const tag = text.match(/^<([a-z_-]+)/i)?.[1];
    return tag
      ? i18n.t("chat:transcript.readTagContext", {
          tag: tag.replace(/[_-]/g, " "),
        })
      : i18n.t("chat:transcript.readContext");
  }
  return i18n.t("chat:transcript.readContext");
}

function chatMessagesForSession(
  session: AgentSession | undefined,
  context: {
    sessions?: AgentSession[];
    suppressedResponseTexts?: ReadonlySet<string>;
  } = {},
): ChatViewMessage[] {
  if (!session) {
    return [];
  }
  const messages: ChatViewMessage[] = [];
  // Every input is a transcript event; only legacy per-turn rows carried
  // their prompt alone, and a list projection has no events yet.
  if (
    !session.events?.some((event) => event.label === sessionInputEventLabel)
  ) {
    messages.push({
      attachments: session.input?.attachments ?? [],
      id: `agent-session:${session.id}:prompt`,
      at: session.startedAt,
      role: "user",
      text: session.input?.prompt ?? session.prompt,
    });
  }
  const sessionActive =
    session.status === "queued" || session.status === "running";
  // A new input's own event can arrive after the session turns active. Until
  // then the transcript still ends with the previous turn: show the input as
  // sent and keep that turn settled instead of reviving its last step.
  const pendingInput =
    sessionActive &&
    session.input &&
    session.events?.some((event) => event.label === sessionInputEventLabel) &&
    !session.events.some((event) => event.message?.id === session.input?.id)
      ? session.input
      : undefined;
  const turnLive = sessionActive && !pendingInput;
  const hasLiveResponse = agentSessionHasStreamedResponse(session);
  const duration = agentSessionDurationLabel(session);
  const terminalError = agentSessionTerminalError(session);
  const segments = projectTranscript(
    sessionTranscriptEntries(session, context.suppressedResponseTexts),
  );
  segments.forEach((segment, index) => {
    const isLastSegment = index === segments.length - 1;
    if (segment.role === "user") {
      messages.push({
        attachments: segment.attachments,
        id: segment.id,
        role: "user",
        at: segment.at,
        text: segment.text,
      });
    } else if (segment.kind === "process") {
      messages.push({
        ...segment,
        id: segment.id,
        kind: "process",
        role: "bot",
        streaming: turnLive && isLastSegment,
        text: segment.text,
        // A group that knows its own duration shows it beside the title.
        title:
          turnLive && isLastSegment
            ? agentSessionActivityTitle(session)
            : isLastSegment
              ? processedTitle(segment.durationMs ? undefined : duration)
              : (segment.title ?? processedTitle(duration)),
      });
    } else if (segment.kind === "boundary" || segment.kind === "failure") {
      messages.push(segment);
    } else {
      messages.push({
        agentLabel: session.profileLabel,
        id: segment.id,
        at: segment.at,
        role: "bot",
        runtime: session.provider,
        statusLabel: isLastSegment
          ? agentSessionStatusLabel(session)
          : undefined,
        streaming: turnLive && !hasLiveResponse && isLastSegment,
        text: segment.text,
        usage: segment.usage,
        fileReferences: segment.fileReferences,
        turnFiles: segment.turnFiles,
      });
    }
  });
  if (pendingInput) {
    // The same id as the event's message, so nothing remounts when it lands.
    messages.push({
      attachments: pendingInput.attachments ?? [],
      at: pendingInput.at,
      id: `agent-session:${session.id}:${pendingInput.id}`,
      role: "user",
      text: pendingInput.prompt,
    });
  }
  if (segments.length === 0 && !terminalError) {
    messages.push({
      agentLabel: session.profileLabel,
      id: `agent-session:${session.id}:fallback`,
      at: session.completedAt,
      role: "bot",
      runtime: session.provider,
      statusLabel: agentSessionStatusLabel(session),
      streaming: sessionActive && !hasLiveResponse,
      text: agentSessionMessageText(session, context),
    });
  }
  if (terminalError) {
    const failure = agentSessionFailureMessage(session, terminalError);
    messages.push({
      id: `agent-session:${session.id}:failure`,
      kind: "failure",
      recoverable: failure.recoverable,
      role: "bot",
      text: failure.text,
      title: failure.title,
    });
  }
  return messages;
}

function processedTitle(duration: string | undefined): string {
  return duration
    ? i18n.t("chat:transcript.processedIn", { duration })
    : i18n.t("chat:transcript.processed");
}

function agentSessionFailureMessage(
  session: AgentSession,
  error: string,
): {
  recoverable: boolean;
  text: string;
  title: string;
} {
  const maxTurnsMatch = error.match(
    /maximum number of turns(?:\s*\((\d+)\))?/i,
  );
  if (maxTurnsMatch) {
    const turns = maxTurnsMatch[1]
      ? i18n.t("chat:failure.turns", { count: Number(maxTurnsMatch[1]) })
      : i18n.t("chat:failure.allowedTurns");
    return {
      recoverable: Boolean(session.nativeSessionId),
      text: session.nativeSessionId
        ? i18n.t("chat:failure.maxTurnsResumable", { turns })
        : i18n.t("chat:failure.maxTurnsLost", { turns }),
      title: i18n.t("chat:failure.maxTurnsTitle"),
    };
  }
  return {
    recoverable: false,
    text: error,
    title: i18n.t("chat:failure.title"),
  };
}

function chatMessagesForThread(
  thread: ChatSessionThread | undefined,
  context: { suppressedResponseTexts?: ReadonlySet<string> } = {},
): ChatViewMessage[] {
  if (!thread) {
    return [];
  }
  return thread.sessions.flatMap((session) =>
    chatMessagesForSession(session, {
      sessions: thread.sessions,
      suppressedResponseTexts: context.suppressedResponseTexts,
    }),
  );
}

function latestCopyableResponseIndex(messages: ChatViewMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      message.role === "bot" &&
      (message.kind === undefined || message.kind === "message") &&
      typeof message.text === "string" &&
      message.text.trim() !== ""
    ) {
      return index;
    }
  }
  return -1;
}

function chatMessageItemId(message: ChatViewMessage, index: number): string {
  if (message.id) {
    return message.id;
  }
  const kind = message.kind ?? "message";
  return `chat-message:${message.role}:${kind}:${stableMessageTextHash(
    `${message.title ?? ""}\n${message.text}`,
  )}:${index}`;
}

const activeProcessLabels: ProcessLabelKey[] = [
  "thinking",
  "usingTool",
  "requestingModel",
  "compactingContext",
  "startingSubtask",
  "searching",
  "runningCommand",
  "editingFile",
  "processingStep",
];
const finishedProcessLabels: ProcessLabelKey[] = [
  "usedTool",
  "searched",
  "ranCommand",
  "editedFile",
  "processedStep",
  "loadedWorkspace",
];

function agentSessionActivityTitle(session: AgentSession): string {
  const latestActivity = [...(session.events ?? [])]
    .reverse()
    .find((event) =>
      isProcessLabel(
        event.label,
        ...activeProcessLabels,
        ...finishedProcessLabels,
      ),
    );
  if (isProcessLabel(latestActivity?.label, ...activeProcessLabels)) {
    return displayProcessLabel(latestActivity!.label);
  }
  return i18n.t("chat:transcript.processing");
}

function agentSessionDurationLabel(session: AgentSession): string | undefined {
  const startedAt = session.startedAt
    ? Date.parse(session.startedAt)
    : Number.NaN;
  const completedAt = session.completedAt
    ? Date.parse(session.completedAt)
    : Number.NaN;
  const times = (session.events ?? [])
    .map((event) => Date.parse(event.at))
    .filter((time) => Number.isFinite(time));
  const firstTime = Number.isFinite(startedAt)
    ? startedAt
    : times.length > 0
      ? Math.min(...times)
      : Number.NaN;
  const lastTime = Number.isFinite(completedAt)
    ? completedAt
    : times.length > 1
      ? Math.max(...times)
      : Number.NaN;
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    return undefined;
  }
  const ms = Math.max(0, lastTime - firstTime);
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes <= 0) {
    return `${restSeconds}s`;
  }
  return `${minutes}m ${restSeconds}s`;
}

export {
  chatMessageItemId,
  chatMessages,
  chatMessagesForThread,
  latestCopyableResponseIndex,
  transcriptDisplayMessages,
};
