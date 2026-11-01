import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  type AgentSession,
  type AgentSessionEvent,
  type FoundryDataProjection,
} from "@bd777/foundry-protocol";
import { fixtureDevice, fixtureWorkspace } from "../src/app/fixtures";
import "../src/styles.css";

// Full App with HTTP / SSE replaced: an open chat whose turn ended while a
// background command and a subagent it started still run. They started
// before its loaded transcript window, so only the thread read's state
// events say so. The buttons end them over the stream; the log records the
// tab's title and icon with the tab's visibility at each change.
const workspace = { ...fixtureWorkspace, id: "ws_tab_status" };
const at = (minute: number) =>
  `2026-10-10T06:${String(minute).padStart(2, "0")}:00.000Z`;
const event = (
  id: string,
  minute: number,
  label: string,
  detail: string,
  metadata?: AgentSessionEvent["metadata"],
): AgentSessionEvent => ({
  id,
  sessionId: "sess_patrol",
  at: at(minute),
  label,
  level: "info",
  detail,
  ...(metadata ? { metadata } : {}),
});
const command = {
  id: "bg1",
  provider: "claude" as const,
  kind: "command" as const,
  description: "Run the suite",
  status: "running" as const,
  startedAt: at(2),
  hasOutput: true,
};
const summary: AgentSession = {
  id: "sess_patrol",
  nativeSessionId: "native_patrol",
  workspaceId: workspace.id,
  agentId: "agent_test",
  deviceId: fixtureDevice.id,
  provider: "claude",
  source: "chat",
  status: "completed",
  title: "Patrol the fleet",
  prompt: "Run the suite and have a reviewer look, in the background",
  response: "Both are running in the background.",
  createdLabel: "today",
  updatedLabel: "completed",
  completedAt: at(40),
};
const thread = {
  ...summary,
  events: [
    event("evt_answer", 40, "Response stream", summary.response!, undefined),
  ],
  stateEvents: [
    event("evt_bg", 2, "Background tasks updated", "", {
      backgroundTaskSnapshot: [command],
    }),
    event("evt_subagent", 3, "Starting subtask", "Review the change", {
      taskId: "agent_1",
      taskType: "local_agent",
      toolUseId: "toolu_1",
    }),
  ],
};
const initialData: FoundryDataProjection = {
  workspace,
  workspaces: [workspace],
  devices: [{ ...fixtureDevice, status: "connected" }],
  deviceProfiles: [],
  deviceSkillRoots: [],
  promotedSkills: [],
  workspaceSkillBindings: [],
  profiles: [],
  agentProfiles: [],
  agents: [
    {
      id: "agent_test",
      workspaceId: workspace.id,
      deviceId: fixtureDevice.id,
      deviceLabel: "Test device",
      provider: "claude",
      status: "healthy",
      authMode: "local_config",
      secretStored: "local",
      configScope: "device",
      configLabel: "Test",
      lastSeenLabel: "now",
    },
  ],
  agentSessions: [summary],
  assets: [],
  chats: [],
  issues: [],
  providerHealth: [],
  skills: [],
  workspaceFiles: [],
};

class FixtureEventSource {
  static current: FixtureEventSource | undefined;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FixtureEventSource.current = this;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener() {}
  close() {
    if (FixtureEventSource.current === this)
      FixtureEventSource.current = undefined;
  }
  static emit(type: string, payload: unknown) {
    this.current?.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
}
const originalFetch = window.fetch;
const originalEventSource = window.EventSource;
window.EventSource = FixtureEventSource as unknown as typeof EventSource;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const status = document.getElementById("fixture-status")!;

const log: { title: string; icon: string; visibility: string }[] = [];
(window as unknown as { tabStatusLog: typeof log }).tabStatusLog = log;
const icon = document.querySelector('link[rel~="icon"]')!;
const record = () => {
  const entry = {
    title: document.title,
    icon: icon.getAttribute("href") ?? "",
    visibility: document.visibilityState,
  };
  const last = log.at(-1);
  if (last?.title !== entry.title || last.icon !== entry.icon) log.push(entry);
};
new MutationObserver(record).observe(document.head, {
  attributes: true,
  characterData: true,
  childList: true,
  subtree: true,
});

const endBackground = () => {
  FixtureEventSource.emit(
    "agent_session_event",
    event("evt_bg_done", 41, "Background tasks updated", "", {
      backgroundTaskSnapshot: [
        { ...command, status: "completed", endedAt: at(41) },
      ],
    }),
  );
  FixtureEventSource.emit(
    "agent_session_event",
    event("evt_subagent_done", 42, "Subtask completed", "Done", {
      taskId: "agent_1",
    }),
  );
  status.textContent = `Ended (${document.visibilityState})`;
};
document
  .getElementById("end-background")!
  .addEventListener("click", endBackground);
document
  .getElementById("end-background-later")!
  .addEventListener("click", () => {
    status.textContent = "Ending in 3 s";
    setTimeout(endBackground, 3000);
  });
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  const path = url.pathname;
  if (path === "/api/foundry-data") return json(initialData);
  if (path.startsWith("/api/agent-session-threads/")) return json([thread]);
  if (path === "/api/chat-layout")
    return json({ revision: 0, groups: [], positions: [] });
  if (path === "/api/chat-titles" || path.endsWith("/subagents"))
    return json([]);
  throw new Error(
    `Unexpected fixture request: ${init?.method ?? "GET"} ${path}`,
  );
};
window.history.replaceState(
  null,
  "",
  `/chats/sess_patrol?workspace=${workspace.id}&device=online`,
);
const { App } = await import("../src/App");
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
import.meta.hot?.dispose(() => {
  root.unmount();
  window.fetch = originalFetch;
  window.EventSource = originalEventSource;
});
