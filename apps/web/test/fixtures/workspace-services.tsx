/** Synthetic UI only: every API call is intercepted, including service controls. */
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import "../../src/styles.css";
import { WorkspaceOverview } from "../../src/features/workspaces/workspace-overview";
import { WorkspaceRow } from "../../src/features/workspaces/workspace-row";
import { SessionWorkSection } from "../../src/features/chat/chat-context-work";
import type { SessionWorkController } from "../../src/features/chat/use-session-work";
import type {
  DeviceProjection,
  SessionWork,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "en");
document.documentElement.lang = i18n.language;
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scenario = params.get("scenario") ?? "empty";
const readOnly = params.get("readonly") === "true";
const workspace = {
  id: "fixture-workspace",
  name: "Services UI fixture",
  localPath: "/synthetic/services",
  baseline: "main",
  contextSummary: "",
  acceptedCount: 0,
  resolvedCount: 0,
  accessRole: readOnly ? "viewer" : "owner",
} as WorkspaceProjection;
const device = {
  id: "fixture-device",
  label: "Fixture device",
  status: "connected",
  owned: true,
} as DeviceProjection;
const item: SessionWork = {
  id: "fixture-service",
  sessionId: "fixture-creator",
  workspaceId: workspace.id,
  deviceId: device.id,
  threadId: "fixture-creator",
  kind: "process",
  source: "foundry",
  title:
    scenario === "long"
      ? "持续运行的合成工作区服务 — LongEnglishServiceTitleWithoutBreaks".repeat(
          4,
        )
      : "Synthetic preview service",
  management: "managed",
  desiredState: "enabled",
  revision: 1,
  generation: 1,
  createdAt: "2026-10-21T06:00:00Z",
  updatedAt: "2026-10-21T06:00:00Z",
  spec: { argv: ["fixture-only", "--long-argument=" + "x".repeat(180)] },
  observation: {
    status: "running",
    confirmedRevision: 1,
    at: "2026-10-21T06:00:00Z",
  },
  allowedActions: ["pause", "resume", "stop"],
  relatedSessionIds: ["fixture-consumer"],
  sharedSessionCount: 1,
};
if (scenario === "pending") {
  item.revision = 2;
  item.desiredState = "stopped";
}
if (scenario === "offline") {
  item.observation.status = "unknown";
  item.observation.error =
    "Fixture device disconnected; execution has not been confirmed.";
}
const fixture = {
  failLoad: scenario === "load-error",
  failControl: scenario === "control-error",
  delay: scenario === "loading" ? 1200 : 0,
  reads: 0,
  controls: [] as unknown[],
  item,
  empty: scenario === "empty",
};
Object.assign(window, { servicesFixture: fixture });
window.fetch = async (input, init) => {
  const url = String(input);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.endsWith("/services")) {
    fixture.reads++;
    if (fixture.delay)
      await new Promise((resolve) => setTimeout(resolve, fixture.delay));
    return fixture.failLoad
      ? json({ error: "Synthetic inventory unavailable" }, 503)
      : json(fixture.empty ? [] : [fixture.item]);
  }
  if (url.endsWith("/operations")) {
    fixture.controls.push(JSON.parse(String(init?.body)));
    if (fixture.delay)
      await new Promise((resolve) => setTimeout(resolve, fixture.delay));
    if (fixture.failControl)
      return json({ error: "Synthetic control failed" }, 503);
    fixture.item.revision++;
    fixture.item.desiredState = "stopped";
    return json({ id: "fixture-operation", state: "pending" });
  }
  if (url.includes("/inspect"))
    return json({
      workspaceId: workspace.id,
      gitState: "ready",
      branch: "main",
      trackedChanges: false,
      head: "fixture",
      inspectedAt: "2026-10-21T06:00:00Z",
      repositories: [],
      errors: [],
      uniqueRepositoryCount: 1,
      scannedAt: "2026-10-21T06:00:00Z",
    });
  throw new Error(`Unexpected fixture request: ${url}`);
};
const noop = () => {};
const view = params.get("view");
createRoot(document.getElementById("root")!).render(
  <main className="fdy-page-surface fdy-workspace-hub">
    <div className="fdy-workspace-hub-heading">
      <h1>{workspace.name}</h1>
      <p>{workspace.localPath}</p>
    </div>
    <div className="fdy-workspace-hub-content">
      {view === "locations" ? (
        <WorkspaceRow
          workspace={workspace}
          device={device}
          current
          busy={false}
          switching={false}
          addingAgainId=""
          detailsRef={noop}
          onDetails={noop}
          onAddAgain={noop}
          onLocate={noop}
          onSwitch={noop}
          onEdit={noop}
          onPrepare={noop}
          onPrepareEnd={noop}
        />
      ) : view === "chat" ? (
        <SessionWorkSection
          canControl={!readOnly}
          controller={
            {
              list: { items: [item], operations: [], coverage: {} },
              refresh: async () => {},
              control: async () => {},
              sessionId: "fixture-consumer",
            } as unknown as SessionWorkController
          }
        />
      ) : (
        <WorkspaceOverview
          workspace={workspace}
          deviceOnline
          deviceLabel={device.label}
          acceptedCount={0}
        />
      )}
    </div>
  </main>,
);
