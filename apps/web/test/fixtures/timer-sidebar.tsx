/** Real sidebar/controller with a closed synthetic API; never executes commands. */
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import { ChatContextCard } from "../../src/features/chat/chat-context-card";
import { useSessionWork } from "../../src/features/chat/use-session-work";
import { sidebarWorkCounts } from "../../src/features/chat/chat-work-state";
import type { ChatContextCardData } from "../../src/features/chat/chat-types";
import type { WorkControlInput, WorkOperation } from "@bd777/foundry-protocol";
import { mixedSidebarInventory } from "./timer-sidebar-data";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.lang = i18n.language;
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "mixed";
const all = mixedSidebarInventory();
const items =
  scenario === "process-only"
    ? all.filter((x) => x.kind === "process")
    : scenario === "ended-only"
      ? all.filter((x) => x.desiredState === "stopped")
      : scenario === "agents-only"
        ? all.filter((x) => x.kind === "agent")
        : all;
if (scenario === "offline") {
  const timer = items.find((item) => item.id === "timer-active")!;
  timer.observation.status = "unknown";
  timer.observation.error =
    "Device disconnected; timer execution is unconfirmed";
}
const fixture = {
  items,
  controls: [] as WorkControlInput[],
  operations: [] as WorkOperation[],
  failControl: scenario === "control-error",
};
Object.assign(window, { sidebarFixture: fixture });
// Keep the hook's live-stream dependency inside the fixture as well as fetch.
window.EventSource = class {
  readyState = 1;
  onopen?: (event: Event) => void;
  constructor() {
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  addEventListener() {}
  close() {}
} as unknown as typeof EventSource;
window.fetch = async (input, init) => {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  const path = String(input);
  if (path.endsWith("/work/operations")) {
    const control = JSON.parse(String(init?.body)) as WorkControlInput;
    fixture.controls.push(control);
    if (fixture.failControl)
      return json({ error: "Synthetic response lost" }, 503);
    const item = items.find((x) => x.id === control.id);
    if (!item || item.kind === "process" || control.action.endsWith("_all"))
      return json({ error: "Hidden/bulk control forbidden" }, 400);
    item.revision++;
    if (control.action === "pause") item.desiredState = "paused";
    if (control.action === "stop") item.desiredState = "stopped";
    fixture.operations.unshift({
      id: "fixture-operation",
      sequence: 1,
      sessionId: "fixture-session",
      action: control.action,
      state: "pending",
      createdAt: new Date().toISOString(),
      items: [{ id: item.id, revision: item.revision }],
    });
    return json(fixture.operations[0]);
  }
  if (path.endsWith("/work"))
    return scenario === "read-error"
      ? json({ error: "Synthetic inventory offline" }, 503)
      : json({
          items,
          operations: fixture.operations,
          barrier: false,
          coverage: {
            scheduler: "observed",
            hostSchedules: "observed",
            processes: "managed_native_and_attributed",
          },
        });
  return json({ error: "Fixture endpoint unavailable" }, 404);
};
const data: ChatContextCardData = {
  changes: [],
  files: [],
  previews: [],
  sources: [],
  background: [
    {
      id: "legacy-command",
      kind: "background-task",
      sessionId: "fixture-session",
      workspaceId: "fixture-workspace",
      label: "cat SECRET-FALLBACK-COMMAND",
      task: {
        id: "legacy-command",
        provider: "codex",
        kind: "command",
        description: "cat SECRET-FALLBACK-COMMAND",
        status: "completed",
        startedAt: "2026-10-21T08:00:00Z",
        hasOutput: true,
      },
    },
  ],
  timers: [
    {
      id: "legacy-timer",
      kind: "timer",
      label: "Legacy native timer",
      sessionId: "fixture-session",
      workspaceId: "fixture-workspace",
      fires: [],
      wake: {},
      busy: false,
      task: {
        id: "legacy-timer",
        kind: "cron",
        humanSchedule: "Daily at 09:00",
        schedule: "0 9 * * *",
        prompt: "Legacy native timer",
        recurring: true,
      },
    },
  ],
  subagents: [
    {
      id: "legacy-agent",
      kind: "subagent",
      runtime: "claude",
      sessionId: "fixture-session",
      workspaceId: "fixture-workspace",
      taskId: "legacy-agent",
      status: "running",
      label: "Legacy native subagent",
    },
  ],
};
function Fixture() {
  const controller = useSessionWork("fixture-session");
  const counts = sidebarWorkCounts(controller.list?.items ?? []);
  return (
    <main
      style={{
        padding: 20,
        minHeight: "100dvh",
        background: "var(--fdy-paper-main)",
      }}
    >
      <p aria-label="Fixture inventory">
        {items.length} inventory records · {counts.timers} timers ·{" "}
        {counts.agents} agents
      </p>
      <div style={{ width: "min(100%, 318px)", marginLeft: "auto" }}>
        <ChatContextCard
          chatKey={`fixture-${scenario}`}
          data={data}
          work={scenario === "fallback" ? undefined : controller}
          canControl={params.get("readonly") !== "true"}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
