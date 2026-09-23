import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  fixtureDevice,
  fixtureWorkspace,
  type AgentSession,
  type FoundryDataProjection,
} from "@foundry/protocol";
import "../src/styles.css";

// Full App / HTTP / SSE fixture. Only the transport is replaced; sending never
// reaches a real server or provider. The SSE frame precedes the POST response
// and its list refresh, reproducing the live-event/detail hydration race.
const workspace = { ...fixtureWorkspace, id: "ws_resume_regression" };
const oldSession: AgentSession = {
  id: "sess_old",
  threadId: "sess_old",
  nativeSessionId: "native_old",
  workspaceId: workspace.id,
  agentId: "agent_test",
  deviceId: fixtureDevice.id,
  provider: "claude",
  source: "chat",
  status: "completed",
  title: "Old session",
  prompt: "First question",
  response: "Historical answer.\n\n".repeat(80),
  createdLabel: "yesterday",
  updatedLabel: "completed",
  events: [],
};
oldSession.events = Array.from({ length: 20 }, (_, index) => ({
  id: `event-${index}`,
  sessionId: oldSession.id,
  at: "2026-09-01T00:00:00Z",
  label: index % 2 ? "Response stream" : "User message",
  level: "info",
  detail:
    index % 2 ? oldSession.response! : `Historical question ${index / 2 + 1}`,
  message: {
    id: `message-${index}`,
    kind: index % 2 ? "assistant" : "user",
    text:
      index % 2 ? oldSession.response! : `Historical question ${index / 2 + 1}`,
  },
}));
let sessions = [
  oldSession,
  ...Array.from({ length: 180 }, (_, index) => ({
    ...oldSession,
    id: `background-${index}`,
    threadId: `background-${index}`,
    nativeSessionId: `background-${index}`,
    title: `Background chat ${index}`,
    prompt: `Background question ${index}`,
    response: "Completed",
    events: [],
  })),
];
const initialData: FoundryDataProjection = {
  workspace,
  workspaces: [workspace],
  devices: [{ ...fixtureDevice, status: "connected" }],
  deviceProfiles: [],
  deviceSkillRoots: [],
  deviceSkills: [],
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
  agentSessions: [],
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
document
  .getElementById("finish-response")!
  .addEventListener("click", async () => {
    const current = sessions.at(-1);
    if (!current || current.status !== "queued") return;
    let next = { ...current, status: "running" as const };
    FixtureEventSource.emit("agent_session_started", next);
    for (let index = 1; index <= 5; index++) {
      const event = {
        id: `evt_${next.id}_response_stream`,
        sessionId: next.id,
        at: "2026-09-07T00:00:00Z",
        label: "Response stream",
        level: "info" as const,
        detail: `Streamed reply ${index} of 5`,
        message: {
          id: `answer-${next.id}`,
          kind: "assistant" as const,
          text: `Streamed reply ${index} of 5`,
        },
      };
      next = { ...next, events: [event] };
      FixtureEventSource.emit("agent_session_event", event);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    const completed = {
      ...next,
      status: "completed" as const,
      response: "Completed fixture response",
    };
    sessions = sessions.map((session) =>
      session.id === completed.id ? completed : session,
    );
    FixtureEventSource.emit("agent_session_completed", completed);
    status.textContent = `Completed ${completed.id}`;
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
  if (path === "/api/agent-sessions" && init?.method === "POST") {
    const request = JSON.parse(String(init.body));
    const session: AgentSession = {
      ...oldSession,
      id: `sess_turn_${sessions.length}`,
      prompt: request.prompt,
      status: "queued",
      response: undefined,
      events: [],
    };
    sessions = [...sessions, session];
    status.textContent = `Queued ${session.id}`;
    FixtureEventSource.emit("agent_session_created", session);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return json(session);
  }
  if (path === "/api/foundry-data")
    return json({ ...initialData, agentSessions: sessions });
  if (path.startsWith("/api/agent-session-threads/")) return json(sessions);
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
  `/chats/sess_old?workspace=${workspace.id}&device=online`,
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
