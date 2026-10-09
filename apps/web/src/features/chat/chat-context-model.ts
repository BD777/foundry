import type {
  AgentBackgroundTask,
  AgentSession,
  AgentSessionEvent,
  AgentSessionTimerFire,
  AgentScheduledTask,
  AgentSubagentSummary,
} from "@bd777/foundry-protocol";
import { humanizeCron } from "@bd777/foundry-protocol";
import type {
  ChatBackgroundTaskItem,
  ChatContextCardData,
  ChatContextResourceItem,
  ChatSessionFileItem,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";
import { i18n } from "../../i18n";
import { isProcessLabel } from "../../lib/process-labels";

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
  summaries: AgentSubagentSummary[],
): ChatSubagentItem[] {
  return summaries.map((summary) => ({
    detail: summary.prompt,
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

function isSessionChange(file: ChatSessionFileItem): boolean {
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
        });
        continue;
      }
      known.op = mergedFileOp(known.op, record.op);
      if (record.origin === "tool") known.origin = "tool";
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

/** Latest snapshot wins: it describes the timers still live in the agent. */
function latestTimerSnapshot(
  session: AgentSession,
): { at: string; tasks: AgentScheduledTask[] } | undefined {
  let snapshot: { at: string; tasks: AgentScheduledTask[] } | undefined;
  for (const event of session.events ?? []) {
    if (event.metadata?.timerSnapshot) {
      snapshot = { at: event.at, tasks: event.metadata.timerSnapshot };
    }
  }
  return snapshot;
}

/**
 * The schedule in the viewer's language, rebuilt from the cron expression
 * rather than the worker's stored (Chinese) humanSchedule. One-off times are
 * resolved from the snapshot's time, as the worker did when recording it.
 */
function timerScheduleLabel(task: AgentScheduledTask, snapshotAt: string) {
  const from = new Date(snapshotAt);
  return humanizeCron(
    task.schedule,
    task.recurring,
    Number.isNaN(from.getTime()) ? new Date() : from,
    i18n.language === "zh-CN" ? "zh-CN" : "en",
  );
}

/** Timer-triggered turns observed for the session, newest first. */
function timerFiresForSession(session: AgentSession): AgentSessionTimerFire[] {
  const fires: AgentSessionTimerFire[] = [];
  for (const event of session.events ?? []) {
    const fire = event.metadata?.timerFire;
    if (fire) {
      fires.push(fire);
    }
  }
  return fires.reverse();
}

function projectSessionTimers(session: AgentSession): ChatTimerItem[] {
  const snapshot = latestTimerSnapshot(session);
  if (!snapshot || snapshot.tasks.length === 0) {
    return [];
  }
  const allFires = timerFiresForSession(session);
  return snapshot.tasks.map((task) => {
    const label = timerScheduleLabel(task, snapshot.at);
    return {
      detail: task.prompt.split(/\r?\n/)[0]?.slice(0, 120) || label,
      fires: allFires.filter((fire) => fire.id === task.id),
      id: `${session.id}:timer:${task.id}`,
      kind: "timer" as const,
      label,
      sessionId: session.id,
      task,
      workspaceId: session.workspaceId,
    };
  });
}

/** Latest snapshot wins: it describes the session's background work. */
function latestBackgroundSnapshot(
  session: AgentSession,
): AgentBackgroundTask[] | undefined {
  let snapshot: AgentBackgroundTask[] | undefined;
  for (const event of session.events ?? []) {
    if (event.metadata?.backgroundTaskSnapshot) {
      snapshot = event.metadata.backgroundTaskSnapshot;
    }
  }
  return snapshot;
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
 * Background work still running for a chat whose turn has ended (subagents
 * included): the chat is idle, yet the agent keeps working.
 */
export function runningBackgroundWork(sessions: AgentSession[]): number {
  const latest = [...sessions]
    .reverse()
    .find((session) => latestBackgroundSnapshot(session));
  if (!latest || latest.provider !== "claude") return 0;
  return (latestBackgroundSnapshot(latest) ?? []).filter(
    (task) => task.status === "running",
  ).length;
}

export interface ActiveWorkspaceContext {
  id: string;
  localPath?: string;
  name?: string;
  deviceLabel?: string;
}

export function chatContextCardForSessions(
  sessions: AgentSession[],
  discoveredSubagents: Readonly<Record<string, AgentSubagentSummary[]>> = {},
  activeWorkspace?: ActiveWorkspaceContext,
): ChatContextCardData | undefined {
  const previews: ChatContextResourceItem[] = [];
  const sources: ChatContextResourceItem[] = [];
  const timers: ChatTimerItem[] = [];
  const focusSession = [...sessions]
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
  const sourceSession = [...sessions]
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
  const sessionFiles = chatSessionFiles(sessions, activeWorkspace);
  const data = {
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
    subagents,
    timers,
    background,
  };
  return data.changes.length > 0 ||
    data.background.length > 0 ||
    data.files.length > 0 ||
    data.previews.length > 0 ||
    data.sources.length > 0 ||
    data.subagents.length > 0 ||
    data.timers.length > 0
    ? data
    : undefined;
}
