import type {
  AgentBackgroundTask,
  AgentContextUsage,
  AgentSession,
  AgentSessionEvent,
  AgentSubagentDigest,
} from "@bd777/foundry-protocol";
import type {
  ChatBackgroundTaskItem,
  ChatContextCardData,
  ChatContextResourceItem,
  ChatScreenItem,
  ChatRunningBackgroundWork,
  ChatSessionFileItem,
  ChatSessionStatus,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";
import { i18n } from "../../i18n";
import { isProcessLabel } from "../../lib/process-labels";
import {
  latestBackgroundSnapshot,
  latestTimerSnapshot,
  withStateEvents,
} from "./chat-state-events";
import { projectSessionTimers } from "./chat-schedule-model";
import { noteTime } from "./chat-time";

// Event labels emitted by workers (protocol values): matched, never shown.
// "Subtask started" / "Subtask finished" are older English spellings.
const isSubagentStart = (label: string) =>
  isProcessLabel(label, "startingSubtask") || label === "Subtask started";
const isSubagentProgress = (label: string) =>
  isProcessLabel(label, "subtaskRunning");
const isSubagentCompleted = (label: string) =>
  isProcessLabel(label, "subtaskCompleted") || label === "Subtask finished";
const isSubagentFailed = (label: string) =>
  isProcessLabel(label, "subtaskFailed");

function isSubagentLifecycleEvent(event: AgentSessionEvent): boolean {
  return (
    event.metadata?.taskType === "local_agent" &&
    (isSubagentStart(event.label) ||
      isSubagentProgress(event.label) ||
      isSubagentCompleted(event.label) ||
      isSubagentFailed(event.label))
  );
}

function firstDetailLine(detail: string, fallback: string): string {
  return (
    detail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? fallback
  );
}

function webResourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const suffix = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${suffix}`;
  } catch {
    return url;
  }
}

function extractWebURLs(value: string): string[] {
  return (value.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((url) =>
    url.replace(/[),.;\]}]+$/, ""),
  );
}

function isWorkspacePreviewURL(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function dedupeResources(
  resources: ChatContextResourceItem[],
): ChatContextResourceItem[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = resource.detail?.trim() || resource.label.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function interruptedSubagentStatus(
  session: AgentSession,
): ChatSubagentItem["status"] {
  if (session.status === "failed") {
    return "failed";
  }
  if (session.status === "canceled") {
    return "canceled";
  }
  return "running";
}

function matchingRunningSubagentIndex(
  subagents: ChatSubagentItem[],
  taskId: string | undefined,
): number {
  return taskId
    ? subagents.findIndex((subagent) => subagent.taskId === taskId)
    : -1;
}

function projectSessionSubagents(session: AgentSession): ChatSubagentItem[] {
  const subagents: ChatSubagentItem[] = [];
  for (const event of session.events ?? []) {
    const taskId = event.metadata?.taskId;
    if (
      isSubagentStart(event.label) &&
      event.metadata?.taskType === "local_agent" &&
      taskId
    ) {
      subagents.push({
        detail: event.detail.trim() || undefined,
        id: event.id,
        kind: "subagent",
        label: firstDetailLine(
          event.detail,
          i18n.t("chat:contextCard.subagentFallback"),
        ),
        runtime: session.provider,
        sessionId: session.id,
        status: "running",
        taskId,
        toolUseId: event.metadata.toolUseId,
        workspaceId: session.workspaceId,
      });
      continue;
    }
    if (isSubagentProgress(event.label)) {
      const index = matchingRunningSubagentIndex(subagents, taskId);
      const candidate = subagents[index];
      if (candidate) {
        subagents[index] = {
          ...candidate,
          detail: event.detail.trim() || candidate.detail,
          usage: event.metadata?.subagentUsage ?? candidate.usage,
        };
      }
      continue;
    }
    const completed = isSubagentCompleted(event.label);
    const failed = isSubagentFailed(event.label);
    if (!completed && !failed) {
      continue;
    }
    const index = matchingRunningSubagentIndex(subagents, taskId);
    const candidate = subagents[index];
    if (candidate) {
      subagents[index] = {
        ...candidate,
        detail: event.detail.trim() || candidate.detail,
        status: failed ? "failed" : "completed",
        usage: event.metadata?.subagentUsage ?? candidate.usage,
      };
    }
  }

  const interruptedStatus = interruptedSubagentStatus(session);
  if (interruptedStatus !== "running") {
    return subagents.map((subagent) =>
      subagent.status === "running"
        ? { ...subagent, status: interruptedStatus }
        : subagent,
    );
  }

  return subagents;
}

function projectDiscoveredSubagents(
  session: AgentSession,
  summaries: AgentSubagentDigest[],
): ChatSubagentItem[] {
  return summaries.map((summary) => ({
    id: `${session.id}:${summary.taskId}`,
    kind: "subagent",
    label: summary.title,
    runtime: session.provider,
    sessionId: session.id,
    status: summary.status,
    taskId: summary.taskId,
    toolUseId: summary.toolUseId,
    usage: summary.usage,
    workspaceId: session.workspaceId,
  }));
}

function mergeSubagents(
  structured: ChatSubagentItem[],
  discovered: ChatSubagentItem[],
): ChatSubagentItem[] {
  const merged = new Map(
    structured.map((subagent) => [subagent.taskId, subagent] as const),
  );
  for (const raw of discovered) {
    const projected = merged.get(raw.taskId);
    if (!projected) {
      merged.set(raw.taskId, raw);
      continue;
    }
    // Raw transcript discovery is authoritative once it reaches a terminal
    // state. A lagging discovery request must never regress a live terminal
    // event back to running, either.
    const status =
      raw.status === "running" && projected.status !== "running"
        ? projected.status
        : raw.status;
    merged.set(raw.taskId, {
      ...projected,
      ...raw,
      detail: projected.detail ?? raw.detail,
      id: projected.id,
      status,
      usage: raw.usage ?? projected.usage,
    });
  }
  return [...merged.values()];
}

/** The op a later turn leaves: a file the chat created stays created. */
function mergedFileOp(
  earlier: ChatSessionFileItem["op"],
  later: ChatSessionFileItem["op"],
): ChatSessionFileItem["op"] {
  if (later === "referenced") return earlier;
  if (later === "deleted" || earlier === "referenced") return later;
  return earlier === "created" ? "created" : later;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * A change: a file the chat's tools wrote in a Git work tree. Only these
 * have a diff; a file an answer only named opens as the file.
 */
export function isSessionChange(file: ChatSessionFileItem): boolean {
  return file.inGitRepo && file.origin === "tool";
}

/**
 * The files the chat's own tools wrote and its answers named, one row per
 * path across its sessions, each with the turns that recorded it. Older
 * workers' `outputFile` events credited every file that changed on disk
 * while they ran; those are not shown.
 */
export function chatSessionFiles(
  sessions: AgentSession[],
  activeWorkspace?: ActiveWorkspaceContext,
): ChatSessionFileItem[] {
  const files = new Map<string, ChatSessionFileItem>();
  for (const session of sessions) {
    for (const event of session.events ?? []) {
      const record = event.metadata?.sessionFile;
      if (!record?.path) continue;
      const turnId = record.inputId ?? session.id;
      const turnCounts =
        record.added !== undefined && record.removed !== undefined
          ? { added: record.added, removed: record.removed }
          : undefined;
      const totalCounts =
        record.totalAdded !== undefined && record.totalRemoved !== undefined
          ? { added: record.totalAdded, removed: record.totalRemoved }
          : turnCounts && !record.inputId
            ? turnCounts
            : undefined;
      const known = files.get(record.path);
      if (!known) {
        files.set(record.path, {
          id: record.path,
          kind: "session-file",
          label: fileName(record.path),
          path: record.path,
          workspacePath: record.workspacePath,
          origin: record.origin,
          op: record.op,
          inGitRepo: record.inGitRepo,
          turnIds: [turnId],
          sessionId: session.id,
          workspaceId: session.workspaceId,
          deviceLabel:
            activeWorkspace?.id === session.workspaceId
              ? activeWorkspace.deviceLabel
              : undefined,
          bytes: record.bytes,
          ...(totalCounts ? { lineChanges: totalCounts } : {}),
          ...(turnCounts ? { turnLineChanges: { [turnId]: turnCounts } } : {}),
          ...(record.totalDiff ? { diff: record.totalDiff } : {}),
          ...(record.diff ? { turnDiff: { [turnId]: record.diff } } : {}),
          ...(record.origin === "tool" ? { diffSessionId: session.id } : {}),
        });
        continue;
      }
      if (totalCounts) known.lineChanges = totalCounts;
      if (turnCounts)
        known.turnLineChanges = {
          ...known.turnLineChanges,
          [turnId]: turnCounts,
        };
      if (record.totalDiff) known.diff = record.totalDiff;
      if (record.diff)
        known.turnDiff = { ...known.turnDiff, [turnId]: record.diff };
      known.op = mergedFileOp(known.op, record.op);
      if (record.origin === "tool") {
        known.origin = "tool";
        known.diffSessionId = session.id;
      }
      known.inGitRepo = record.inGitRepo;
      known.workspacePath = record.workspacePath ?? known.workspacePath;
      known.bytes = record.bytes ?? known.bytes;
      known.sessionId = session.id;
      if (!known.turnIds.includes(turnId)) known.turnIds.push(turnId);
    }
  }
  return [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/** A preview a run reported, such as a dev server on localhost. */
function previewOutputURL(event: AgentSessionEvent): string | undefined {
  if (event.level !== "info") return undefined;
  if (!/\b(?:SDK|CLI|command) finished$/i.test(event.label.trim()))
    return undefined;
  return extractWebURLs(event.detail).find(isWorkspacePreviewURL);
}

function isOutputEvent(event: AgentSessionEvent): boolean {
  return Boolean(event.metadata?.sessionFile || previewOutputURL(event));
}

function isWorkspaceSourceEvent(event: AgentSessionEvent): boolean {
  return (
    isProcessLabel(event.label, "loadedWorkspace") && event.detail.trim() !== ""
  );
}

function backgroundRecency(task: AgentBackgroundTask): string {
  return task.endedAt ?? task.startedAt;
}

/**
 * The session's commands, monitors and workflows: running ones first, then
 * the most recently finished. Background subagents are listed under
 * Subagents. Only Claude reports background work.
 */
export function projectBackgroundTasks(
  session: AgentSession,
): ChatBackgroundTaskItem[] {
  if (session.provider !== "claude") return [];
  const snapshot = latestBackgroundSnapshot(session) ?? [];
  const subagents = new Map(
    snapshot
      .filter((task) => task.kind === "subagent")
      .map((task) => [task.id, task.description] as const),
  );
  return snapshot
    .filter((task) => task.kind !== "subagent")
    .sort((left, right) => {
      const leftRunning = left.status === "running" ? 0 : 1;
      const rightRunning = right.status === "running" ? 0 : 1;
      if (leftRunning !== rightRunning) return leftRunning - rightRunning;
      return leftRunning === 0
        ? left.startedAt.localeCompare(right.startedAt)
        : backgroundRecency(right).localeCompare(backgroundRecency(left));
    })
    .map((task) => ({
      id: `${session.id}:background:${task.id}`,
      kind: "background-task" as const,
      label:
        task.description.trim() ||
        i18n.t("chat:contextCard.backgroundFallback"),
      task,
      ownerLabel: task.ownerSubagentTaskId
        ? (subagents.get(task.ownerSubagentTaskId) ??
          i18n.t("chat:contextCard.backgroundOwnerFallback"))
        : undefined,
      sessionId: session.id,
      workspaceId: session.workspaceId,
    }));
}

/**
 * Work still running for a chat whose turn has ended: the chat is idle, yet
 * the agent keeps working. Read from the side panel's own rows, so the note
 * counts exactly the running rows of its Background and Subagents sections.
 */
export function runningBackgroundWork(
  card: ChatContextCardData | undefined,
): ChatRunningBackgroundWork {
  // A timer's run Claude started on its own works like a turn of its own.
  const timerRun = card?.timers.find((item) => item.running);
  return {
    taskIds: (card?.background ?? [])
      .filter((item) => item.task.status === "running")
      .map((item) => item.id),
    subagentIds: (card?.subagents ?? [])
      .filter((item) => item.status === "running")
      .map((item) => item.id),
    ...(timerRun
      ? {
          timerRun: {
            id: timerRun.id,
            ...(timerRun.running?.startedAt
              ? { startedAt: timerRun.running.startedAt }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * "Scheduled task running since 11:30" and/or "2 tasks and 1 subagent
 * running in the background"; empty when nothing runs.
 */
export function backgroundWorkNote(
  work: ChatRunningBackgroundWork,
  now: Date = new Date(),
): string {
  const startedAt = work.timerRun?.startedAt
    ? new Date(work.timerRun.startedAt)
    : undefined;
  const timerNote = !work.timerRun
    ? ""
    : startedAt && !Number.isNaN(startedAt.getTime())
      ? i18n.t("chat:contextCard.timerRunningSinceNote", {
          time: noteTime(startedAt, now),
        })
      : i18n.t("chat:contextCard.timerRunningNote");
  const tasksNote = backgroundTasksNote(work);
  return [timerNote, tasksNote].filter(Boolean).join(" · ");
}

function backgroundTasksNote(work: ChatRunningBackgroundWork): string {
  const tasks = work.taskIds.length;
  const subagents = work.subagentIds.length;
  if (tasks > 0 && subagents > 0) {
    return i18n.t("chat:contextCard.backgroundRunningNoteMixed", {
      tasks: i18n.t("chat:contextCard.backgroundTaskCount", { count: tasks }),
      subagents: i18n.t("chat:contextCard.backgroundSubagentCount", {
        count: subagents,
      }),
    });
  }
  if (subagents > 0) {
    return i18n.t("chat:contextCard.backgroundSubagentsNote", {
      count: subagents,
    });
  }
  if (tasks > 0) {
    return i18n.t("chat:contextCard.backgroundRunningNote", { count: tasks });
  }
  return "";
}

/**
 * The open session's status line. The context is the newest report of it
 * (a compaction's included); workers before those reports name only each
 * request's tokens, so their window is unknown. Turns, their totals and
 * compactions count every one the session's events and state events hold.
 */
export function chatSessionStatus(
  session: AgentSession,
  activeWorkspace?: ActiveWorkspaceContext,
): ChatSessionStatus {
  let context: AgentContextUsage | undefined;
  let window: { tokens: number; model?: string } | undefined;
  let configured: AgentContextUsage["configuredWindow"];
  let requestTokens: number | undefined;
  let compactions = 0;
  let turns = 0;
  let lastTurnDurationMs: number | undefined;
  const totals: ChatSessionStatus["totals"] = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costTurns: 0,
  };
  for (const event of session.events ?? []) {
    const metadata = event.metadata;
    if (!metadata) continue;
    if (metadata.contextUsage) {
      context = metadata.contextUsage;
      if (context.compaction) compactions += 1;
      configured = context.configuredWindow ?? configured;
      if (context.contextWindow)
        window = { tokens: context.contextWindow, model: context.model };
    } else if (metadata.requestUsage) {
      requestTokens = metadata.requestUsage.inputTokens;
    }
    const usage = metadata.turnUsage;
    if (usage) {
      turns += 1;
      totals.inputTokens += usage.inputTokens;
      totals.cacheReadTokens += usage.cacheReadTokens;
      totals.cacheWriteTokens += usage.cacheWriteTokens;
      totals.outputTokens += usage.outputTokens;
      if (usage.costUsd !== undefined) {
        totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
        totals.costTurns += 1;
      }
      lastTurnDurationMs = usage.durationMs;
    }
  }
  // A report made before its model's window was known takes the one a
  // later report of the same model named.
  // Before the runtime names a window, the one Foundry set stands in.
  const contextWindow =
    context?.contextWindow ??
    (window && (!context?.model || window.model === context.model)
      ? window.tokens
      : undefined) ??
    configured?.tokens;
  const model = context?.model || session.model?.trim() || undefined;
  const effort =
    session.provider === "claude"
      ? session.claudeEffort
      : session.codexReasoningEffort;
  return {
    sessionId: session.id,
    ...(session.nativeSessionId
      ? { nativeSessionId: session.nativeSessionId }
      : {}),
    runtime: session.provider,
    ...(session.profileLabel ? { profileLabel: session.profileLabel } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(session.provider === "claude" && session.claudePermissionMode
      ? { claudePermissionMode: session.claudePermissionMode }
      : {}),
    ...(session.provider === "codex" && session.codexSandboxMode
      ? { codexSandboxMode: session.codexSandboxMode }
      : {}),
    ...(session.provider === "codex" && session.codexApprovalPolicy
      ? { codexApprovalPolicy: session.codexApprovalPolicy }
      : {}),
    ...(session.source === "verification" ? { verification: true } : {}),
    ...(activeWorkspace?.deviceLabel &&
    activeWorkspace.id === session.workspaceId
      ? { deviceLabel: activeWorkspace.deviceLabel }
      : {}),
    context: {
      ...((context ? context.inputTokens : requestTokens) !== undefined
        ? { usedTokens: context ? context.inputTokens : requestTokens }
        : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(configured ? { configured } : {}),
    },
    turns,
    totals,
    ...(lastTurnDurationMs !== undefined ? { lastTurnDurationMs } : {}),
    compactions,
  };
}

export interface ActiveWorkspaceContext {
  id: string;
  localPath?: string;
  name?: string;
  deviceLabel?: string;
  /** Set when the viewer may open the device's files outside workspaces. */
  deviceFiles?: { deviceId: string; deviceLabel?: string };
}

/** The newest tool screenshot of the newest session that has one. */
export function latestScreen(
  sessions: AgentSession[],
): ChatScreenItem | undefined {
  for (const session of [...sessions].reverse()) {
    const events = session.events ?? [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const frame = events[index]!.metadata?.toolFrame;
      if (!frame) continue;
      return {
        id: `screen:${session.id}`,
        kind: "screen",
        label: i18n.t(`conversation:process.frameSource.${frame.source}`),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        latest: { ...frame, sessionId: session.id },
      };
    }
  }
  return undefined;
}

export function chatContextCardForSessions(
  sessions: AgentSession[],
  discoveredSubagents: Readonly<Record<string, AgentSubagentDigest[]>> = {},
  activeWorkspace?: ActiveWorkspaceContext,
): ChatContextCardData | undefined {
  const previews: ChatContextResourceItem[] = [];
  const sources: ChatContextResourceItem[] = [];
  const timers: ChatTimerItem[] = [];
  // The panel shows each session's state, whichever of its events are loaded.
  const panelSessions = sessions.map(withStateEvents);
  const focusSession = [...panelSessions]
    .reverse()
    .find(
      (session) =>
        (session.events ?? []).some(
          (event) =>
            isSubagentLifecycleEvent(event) ||
            isOutputEvent(event) ||
            (event.metadata?.timerSnapshot?.length ?? 0) > 0 ||
            (event.metadata?.backgroundTaskSnapshot?.length ?? 0) > 0,
        ) ||
        (discoveredSubagents[session.id]?.length ?? 0) > 0 ||
        (latestTimerSnapshot(session)?.tasks.length ?? 0) > 0 ||
        extractWebURLs(session.response ?? "").length > 0,
    );
  const sourceSession = [...panelSessions]
    .reverse()
    .find((session) => (session.events ?? []).some(isWorkspaceSourceEvent));
  const background = focusSession ? projectBackgroundTasks(focusSession) : [];
  const subagents = focusSession
    ? mergeSubagents(
        projectSessionSubagents(focusSession),
        projectDiscoveredSubagents(
          focusSession,
          discoveredSubagents[focusSession.id] ?? [],
        ),
      )
    : ([] as ChatSubagentItem[]);

  if (focusSession) {
    timers.push(...projectSessionTimers(focusSession));
    for (const event of [...(focusSession.events ?? [])].reverse()) {
      const preview = previewOutputURL(event);
      if (preview) {
        previews.push({
          detail: preview,
          id: event.id,
          kind: "web",
          label: webResourceLabel(preview),
          target: preview,
          workspaceId: focusSession.workspaceId,
        });
      }
    }
    for (const [index, url] of extractWebURLs(focusSession.response ?? "")
      .filter(isWorkspacePreviewURL)
      .entries()) {
      previews.push({
        detail: url,
        id: `${focusSession.id}_web_${index}`,
        kind: "web",
        label: webResourceLabel(url),
        target: url,
        workspaceId: focusSession.workspaceId,
      });
    }
  }
  if (sourceSession) {
    for (const event of sourceSession.events ?? []) {
      if (isWorkspaceSourceEvent(event)) {
        const target = event.detail.trim();
        const webURL = extractWebURLs(target)[0];
        sources.push({
          detail: target,
          id: event.id,
          kind: webURL ? "web" : "source",
          label: webURL ? webResourceLabel(webURL) : target,
          target: webURL ?? target,
          workspaceId: sourceSession.workspaceId,
        });
      }
    }
  } else if (activeWorkspace && activeWorkspace.localPath) {
    sources.push({
      detail: activeWorkspace.localPath,
      id: `workspace_source_${activeWorkspace.id}`,
      kind: "source",
      label: activeWorkspace.localPath,
      target: activeWorkspace.localPath,
      workspaceId: activeWorkspace.id,
    });
  }

  const seenPreviews = new Set<string>();
  const sessionFiles = chatSessionFiles(panelSessions, activeWorkspace);
  const screen = latestScreen(panelSessions);
  const openSession = panelSessions.at(-1);
  const data = {
    ...(openSession
      ? { status: chatSessionStatus(openSession, activeWorkspace) }
      : {}),
    // Changes are what this chat's own tools edited in a repository; a file
    // the answer only names is a file to open, not a change.
    changes: sessionFiles.filter(isSessionChange),
    files: sessionFiles.filter((file) => !isSessionChange(file)),
    previews: previews.filter((item) => {
      if (seenPreviews.has(item.target)) return false;
      seenPreviews.add(item.target);
      return true;
    }),
    sources: dedupeResources(sources),
    ...(screen ? { screen } : {}),
    // Paths resolve against the folder of the workspace the chat runs in.
    ...(activeWorkspace?.localPath &&
    (!openSession || openSession.workspaceId === activeWorkspace.id)
      ? { workspaceRoot: activeWorkspace.localPath }
      : {}),
    ...(activeWorkspace?.deviceFiles &&
    (!openSession || openSession.workspaceId === activeWorkspace.id)
      ? { deviceFiles: activeWorkspace.deviceFiles }
      : {}),
    subagents,
    timers,
    background,
  };
  return data.status ||
    data.changes.length > 0 ||
    data.background.length > 0 ||
    data.files.length > 0 ||
    data.previews.length > 0 ||
    data.screen ||
    data.sources.length > 0 ||
    data.subagents.length > 0 ||
    data.timers.length > 0
    ? data
    : undefined;
}
