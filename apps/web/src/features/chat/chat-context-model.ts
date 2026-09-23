import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionTimerFire,
  AgentScheduledTask,
  AgentSubagentSummary,
} from "@foundry/protocol";
import type {
  ChatContextCardData,
  ChatContextResourceItem,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";

const subagentStartLabels = new Set([
  "正在启动子任务",
  "Starting subtask",
  "Subtask started",
]);
const subagentProgressLabels = new Set(["子任务进行中", "Subtask running"]);
const subagentCompletedLabels = new Set([
  "子任务完成",
  "Subtask completed",
  "Subtask finished",
]);
const subagentFailedLabels = new Set(["子任务失败", "Subtask failed"]);

function isSubagentLifecycleEvent(event: AgentSessionEvent): boolean {
  return (
    event.metadata?.taskType === "local_agent" &&
    (subagentStartLabels.has(event.label) ||
      subagentProgressLabels.has(event.label) ||
      subagentCompletedLabels.has(event.label) ||
      subagentFailedLabels.has(event.label))
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
      subagentStartLabels.has(event.label) &&
      event.metadata?.taskType === "local_agent" &&
      taskId
    ) {
      subagents.push({
        detail: event.detail.trim() || undefined,
        id: event.id,
        kind: "subagent",
        label: firstDetailLine(event.detail, "Subagent"),
        runtime: session.provider,
        sessionId: session.id,
        status: "running",
        taskId,
        toolUseId: event.metadata.toolUseId,
        workspaceId: session.workspaceId,
      });
      continue;
    }
    if (subagentProgressLabels.has(event.label)) {
      const index = matchingRunningSubagentIndex(subagents, taskId);
      const candidate = subagents[index];
      if (candidate) {
        subagents[index] = {
          ...candidate,
          detail: event.detail.trim() || candidate.detail,
        };
      }
      continue;
    }
    const completed = subagentCompletedLabels.has(event.label);
    const failed = subagentFailedLabels.has(event.label);
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
    });
  }
  return [...merged.values()];
}

function isOutputEvent(event: AgentSessionEvent): boolean {
  return (
    event.level === "info" &&
    (/\b(?:SDK|CLI|command) finished$/i.test(event.label.trim()) ||
      Boolean(event.metadata?.outputFile)) &&
    event.detail.trim() !== ""
  );
}

function isWorkspaceSourceEvent(event: AgentSessionEvent): boolean {
  return (
    /^(?:Loaded workspace|已加载工作区)$/i.test(event.label.trim()) &&
    event.detail.trim() !== ""
  );
}

/** Latest snapshot wins: it describes the timers still live in the agent. */
function latestTimerSnapshot(
  session: AgentSession,
): AgentScheduledTask[] | undefined {
  let snapshot: AgentScheduledTask[] | undefined;
  for (const event of session.events ?? []) {
    if (event.metadata?.timerSnapshot) {
      snapshot = event.metadata.timerSnapshot;
    }
  }
  return snapshot;
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
  if (!snapshot || snapshot.length === 0) {
    return [];
  }
  const allFires = timerFiresForSession(session);
  return snapshot.map((task) => ({
    detail: task.prompt.split(/\r?\n/)[0]?.slice(0, 120) || task.humanSchedule,
    fires: allFires.filter((fire) => fire.id === task.id),
    id: `${session.id}:timer:${task.id}`,
    kind: "timer" as const,
    label: task.humanSchedule,
    sessionId: session.id,
    task,
    workspaceId: session.workspaceId,
  }));
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
        (latestTimerSnapshot(session)?.length ?? 0) > 0 ||
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
    for (const event of focusSession.events ?? []) {
      if (isOutputEvent(event)) {
        const target = (event.metadata?.outputFile || event.detail).trim();
        const webURL = extractWebURLs(target)[0];
        outputs.push({
          detail: target,
          id: event.id,
          kind: webURL ? "web" : "file",
          label: webURL
            ? webResourceLabel(webURL)
            : resourceLabel(target) || "Output",
          target: webURL ?? target,
          workspaceId: focusSession.workspaceId,
        });
      }
    }
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

  const dedupedOutputs = dedupeResources(outputs);
  dedupedOutputs.sort((a, b) => {
    const isResultA =
      a.label === "result.md" || a.target.endsWith("/result.md");
    const isResultB =
      b.label === "result.md" || b.target.endsWith("/result.md");
    if (isResultA !== isResultB) {
      return isResultA ? 1 : -1;
    }
    return a.label.localeCompare(b.label);
  });

  const data = {
    outputs: dedupedOutputs,
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
