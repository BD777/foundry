import type {
  AgentSession,
  AgentSessionPanel,
  AgentSubagentDigest,
} from "@bd777/foundry-protocol";
import type { WindowedAgentSession } from "../../../api";
import type {
  ChatBackgroundTaskItem,
  ChatContextCardData,
  ChatContextResourceItem,
  ChatScreenItem,
  ChatRunningBackgroundWork,
  ChatSessionFileItem,
  ChatSessionStatus,
  ChatSubagentItem,
} from "../chat-types";
import { i18n } from "../../../i18n";
import { projectSessionTimers } from "./chat-schedule-model";
import { noteTime } from "../chat-time";

/**
 * The side panel the server derived for the session: it comes with the
 * newest window of a session read and as agent_session_panel. The panel
 * renders it; it derives nothing from the session's events.
 */
export function sessionPanel(
  session: AgentSession,
): AgentSessionPanel | undefined {
  return (session as WindowedAgentSession).panel;
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

function webURLOf(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;\]}]+$/, "");
}

function projectSessionSubagents(
  session: AgentSession,
  panel: AgentSessionPanel,
): ChatSubagentItem[] {
  return panel.subagents.map((subagent) => ({
    ...(subagent.detail ? { detail: subagent.detail } : {}),
    id: subagent.id,
    kind: "subagent",
    label: firstDetailLine(
      subagent.detail ?? "",
      i18n.t("chat:contextCard.subagentFallback"),
    ),
    runtime: session.provider,
    sessionId: session.id,
    status: subagent.status,
    taskId: subagent.taskId,
    toolUseId: subagent.toolUseId,
    usage: subagent.usage,
    workspaceId: session.workspaceId,
  }));
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
 * path, as the session's panel merged them (a chat thread is one session).
 */
export function chatSessionFiles(
  sessions: AgentSession[],
  activeWorkspace?: ActiveWorkspaceContext,
): ChatSessionFileItem[] {
  const files = new Map<string, ChatSessionFileItem>();
  for (const session of sessions) {
    for (const file of sessionPanel(session)?.files ?? []) {
      files.set(file.path, {
        id: file.path,
        kind: "session-file",
        label: fileName(file.path),
        path: file.path,
        workspacePath: file.workspacePath,
        origin: file.origin,
        op: file.op,
        inGitRepo: file.inGitRepo,
        turnIds: file.turnIds,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        deviceLabel:
          activeWorkspace?.id === session.workspaceId
            ? activeWorkspace.deviceLabel
            : undefined,
        bytes: file.bytes,
        ...(file.lineChanges ? { lineChanges: file.lineChanges } : {}),
        ...(file.turnLineChanges
          ? { turnLineChanges: file.turnLineChanges }
          : {}),
        ...(file.diff ? { diff: file.diff } : {}),
        ...(file.turnDiff ? { turnDiff: file.turnDiff } : {}),
        ...(file.origin === "tool" ? { diffSessionId: session.id } : {}),
      });
    }
  }
  return [...files.values()];
}

/**
 * The session's commands, monitors and workflows, in the panel's order.
 * Background subagents are listed under Subagents.
 */
export function projectBackgroundTasks(
  session: AgentSession,
): ChatBackgroundTaskItem[] {
  return (sessionPanel(session)?.background ?? []).map(({ task, owner }) => ({
    id: `${session.id}:background:${task.id}`,
    kind: "background-task" as const,
    label:
      task.description.trim() || i18n.t("chat:contextCard.backgroundFallback"),
    task,
    ownerLabel: task.ownerSubagentTaskId
      ? (owner ?? i18n.t("chat:contextCard.backgroundOwnerFallback"))
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

const noTotals: ChatSessionStatus["totals"] = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costTurns: 0,
};

/**
 * The open session's status line: its settings, and the context and usage
 * its panel reports.
 */
export function chatSessionStatus(
  session: AgentSession,
  activeWorkspace?: ActiveWorkspaceContext,
): ChatSessionStatus {
  const usage = sessionPanel(session)?.usage;
  const model = usage?.model || session.model?.trim() || undefined;
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
      ...(usage?.usedTokens !== undefined
        ? { usedTokens: usage.usedTokens }
        : {}),
      ...(usage?.contextWindow ? { contextWindow: usage.contextWindow } : {}),
      ...(usage?.configured ? { configured: usage.configured } : {}),
    },
    turns: usage?.turns ?? 0,
    totals: usage?.totals ?? noTotals,
    ...(usage?.lastTurnDurationMs !== undefined
      ? { lastTurnDurationMs: usage.lastTurnDurationMs }
      : {}),
    compactions: usage?.compactions ?? 0,
    ...(usage?.lastCompaction ? { lastCompaction: usage.lastCompaction } : {}),
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
    const frame = sessionPanel(session)?.screen;
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
  return undefined;
}

export function chatContextCardForSessions(
  sessions: AgentSession[],
  discoveredSubagents: Readonly<Record<string, AgentSubagentDigest[]>> = {},
  activeWorkspace?: ActiveWorkspaceContext,
): ChatContextCardData | undefined {
  const sources: ChatContextResourceItem[] = [];
  const focusSession = [...sessions]
    .reverse()
    .find(
      (session) =>
        sessionPanel(session)?.focus ||
        (discoveredSubagents[session.id]?.length ?? 0) > 0,
    );
  const focusPanel = focusSession && sessionPanel(focusSession);
  const sourceSession = [...sessions]
    .reverse()
    .find((session) => (sessionPanel(session)?.sources.length ?? 0) > 0);
  const background = focusSession ? projectBackgroundTasks(focusSession) : [];
  const subagents = focusSession
    ? mergeSubagents(
        focusPanel ? projectSessionSubagents(focusSession, focusPanel) : [],
        projectDiscoveredSubagents(
          focusSession,
          discoveredSubagents[focusSession.id] ?? [],
        ),
      )
    : ([] as ChatSubagentItem[]);
  const timers = focusSession ? projectSessionTimers(focusSession) : [];
  const previews: ChatContextResourceItem[] = (focusPanel?.previews ?? []).map(
    (preview) => ({
      detail: preview.target,
      id: preview.id,
      kind: "web",
      label: webResourceLabel(preview.target),
      target: preview.target,
      workspaceId: focusSession?.workspaceId,
    }),
  );
  if (sourceSession) {
    for (const source of sessionPanel(sourceSession)?.sources ?? []) {
      const webURL = webURLOf(source.target);
      sources.push({
        detail: source.target,
        id: source.id,
        kind: webURL ? "web" : "source",
        label: webURL ? webResourceLabel(webURL) : source.target,
        target: webURL ?? source.target,
        workspaceId: sourceSession.workspaceId,
      });
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

  const sessionFiles = chatSessionFiles(sessions, activeWorkspace);
  const screen = latestScreen(sessions);
  const openSession = sessions.at(-1);
  const data = {
    ...(openSession
      ? { status: chatSessionStatus(openSession, activeWorkspace) }
      : {}),
    // Changes are what this chat's own tools edited in a repository; a file
    // the answer only names is a file to open, not a change.
    changes: sessionFiles.filter(isSessionChange),
    files: sessionFiles.filter((file) => !isSessionChange(file)),
    previews,
    sources,
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
