import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionTimerFire,
  AgentScheduledTask,
  AgentSubagentSummary,
} from "@bd777/foundry-protocol";
import { humanizeCron } from "@bd777/foundry-protocol";
import type {
  ChatContextCardData,
  ChatContextResourceItem,
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

function resourceLabel(detail: string): string {
  const trimmed = detail.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
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

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

/**
 * A file in the workspace the run created or changed, as the worker reports
 * it (relative to the workspace). Files outside the workspace, such as Claude
 * background-task logs, cannot be opened from here; their subagent shows
 * them.
 */
function workspaceOutputFile(event: AgentSessionEvent): string | undefined {
  const file = event.metadata?.outputFile?.trim();
  return event.level === "info" &&
    file &&
    !isAbsolutePath(file) &&
    extractWebURLs(file).length === 0
    ? file
    : undefined;
}

/** A preview a run reported, such as a dev server on localhost. */
function previewOutputURL(event: AgentSessionEvent): string | undefined {
  if (event.level !== "info") return undefined;
  if (!/\b(?:SDK|CLI|command) finished$/i.test(event.label.trim()))
    return undefined;
  return extractWebURLs(event.detail).find(isWorkspacePreviewURL);
}

function isOutputEvent(event: AgentSessionEvent): boolean {
  return Boolean(workspaceOutputFile(event) || previewOutputURL(event));
}

function folderOf(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : undefined;
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

export interface ActiveWorkspaceContext {
  id: string;
  localPath?: string;
  name?: string;
}

export function chatContextCardForSessions(
  sessions: AgentSession[],
  discoveredSubagents: Readonly<Record<string, AgentSubagentSummary[]>> = {},
  activeWorkspace?: ActiveWorkspaceContext,
): ChatContextCardData | undefined {
  const outputs: ChatContextResourceItem[] = [];
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
            Boolean(event.metadata?.timerSnapshot),
        ) ||
        (discoveredSubagents[session.id]?.length ?? 0) > 0 ||
        (latestTimerSnapshot(session)?.tasks.length ?? 0) > 0 ||
        extractWebURLs(session.response ?? "").length > 0,
    );
  const sourceSession = [...sessions]
    .reverse()
    .find((session) => (session.events ?? []).some(isWorkspaceSourceEvent));
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
    // Newest first; a file the reply names comes before the rest.
    const reply = focusSession.response ?? "";
    const files: ChatContextResourceItem[] = [];
    for (const event of [...(focusSession.events ?? [])].reverse()) {
      const file = workspaceOutputFile(event);
      const preview = file ? undefined : previewOutputURL(event);
      if (preview) {
        outputs.push({
          detail: preview,
          id: event.id,
          kind: "web",
          label: webResourceLabel(preview),
          target: preview,
          workspaceId: focusSession.workspaceId,
        });
      } else if (file && !files.some((item) => item.target === file)) {
        files.push({
          detail: folderOf(file),
          id: event.id,
          kind: "file",
          label:
            resourceLabel(file) || i18n.t("chat:contextCard.outputFallback"),
          ...(reply.includes(file) ? { mentioned: true } : {}),
          target: file,
          workspaceId: focusSession.workspaceId,
        });
      }
    }
    outputs.push(
      ...files
        .filter((item) => item.mentioned)
        .concat(files.filter((item) => !item.mentioned)),
    );
    for (const [index, url] of extractWebURLs(focusSession.response ?? "")
      .filter(isWorkspacePreviewURL)
      .entries()) {
      outputs.push({
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

  const seenOutputs = new Set<string>();
  const data = {
    outputs: outputs.filter((item) => {
      if (seenOutputs.has(item.target)) return false;
      seenOutputs.add(item.target);
      return true;
    }),
    sources: dedupeResources(sources),
    subagents,
    timers,
  };
  return data.outputs.length > 0 ||
    data.sources.length > 0 ||
    data.subagents.length > 0 ||
    data.timers.length > 0
    ? data
    : undefined;
}
