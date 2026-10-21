import type { SessionWork } from "@bd777/foundry-protocol";

export function sidebarWork(
  id: string,
  kind: SessionWork["kind"],
  status: SessionWork["observation"]["status"],
  source: SessionWork["source"] = "foundry",
): SessionWork {
  const ended = ["completed", "failed", "stopped"].includes(status);
  const native = source === "codex" || source === "claude";
  return {
    id,
    sessionId: "fixture-session",
    threadId: "fixture-session",
    workspaceId: "fixture-workspace",
    deviceId: "fixture-device",
    kind,
    source,
    sourceId: id,
    title: id,
    management: native ? "observed" : "managed",
    desiredState: ended ? "stopped" : "enabled",
    revision: 1,
    generation: 1,
    createdAt: "2026-10-21T08:00:00Z",
    updatedAt: "2026-10-21T08:00:00Z",
    spec:
      kind === "schedule" ? { schedule: "0 9 * * *", recurring: !ended } : {},
    observation: {
      status,
      at: "2026-10-21T08:00:00Z",
      confirmedRevision: 1,
      ...(ended ? { endedAt: "2026-10-21T08:00:00Z" } : {}),
    },
    allowedActions: native ? [] : ["pause", "resume", "stop", "run", "remove"],
    ...(native
      ? {
          native: {
            runtime: source,
            version: "fixture",
            sessionId: "native-fixture",
            taskId: id,
            discovery: "synthetic fixture",
            observation: "available" as const,
            controls: {
              stop: "unsupported" as const,
              pause: "unsupported" as const,
              resume: "unsupported" as const,
            },
          },
        }
      : {}),
  };
}

/** 119 records: 111 command executions, 4 timers, 3 agents, 1 durable service. */
export function mixedSidebarInventory(): SessionWork[] {
  const commands = [
    "cat README.md",
    "ssh dev uptime",
    "git status --short",
    "python3 -m unittest",
    "pnpm test",
  ];
  const history = Array.from({ length: 111 }, (_, index) => ({
    ...sidebarWork(
      `command-${index}`,
      "process",
      index === 0 ? "running" : index % 7 ? "completed" : "failed",
      "codex",
    ),
    title: `${commands[index % commands.length]} — tool ${index}`,
  }));
  return [
    ...history,
    {
      ...sidebarWork("timer-active", "schedule", "idle"),
      title: "每日检查 · Long timer title keeps its own schedule and controls",
    },
    {
      ...sidebarWork("timer-native", "schedule", "running", "claude"),
      title: "Claude native timer",
    },
    {
      ...sidebarWork("timer-ended", "schedule", "completed"),
      title: "Completed durable timer",
    },
    {
      ...sidebarWork("timer-native-ended", "schedule", "stopped", "claude"),
      title: "Ended native timer",
    },
    {
      ...sidebarWork("agent-child", "agent", "running"),
      title: "Foundry direct child session",
      sourceId: "fixture-child",
    },
    {
      ...sidebarWork("agent-native", "agent", "running", "codex"),
      title: "Codex native subagent",
    },
    {
      ...sidebarWork("agent-ended", "agent", "completed", "claude"),
      title: "Ended Claude subagent",
    },
    {
      ...sidebarWork("service", "process", "running"),
      title: "Workspace durable service",
      relatedSessionIds: ["fixture-consumer"],
      sharedSessionCount: 1,
    },
  ];
}
