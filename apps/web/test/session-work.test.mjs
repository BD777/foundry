import { i18n } from "../src/i18n/index.ts";
await i18n.changeLanguage("cimode");
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWorkSection } from "../src/features/chat/chat-context-work.tsx";
import {
  workActions,
  isCurrentWork,
  isSidebarWork,
  sidebarWorkCounts,
} from "../src/features/chat/chat-work-state.ts";
import { isOutstandingWork } from "@bd777/foundry-protocol";
function work(overrides = {}) {
  return {
    id: "work_a",
    sessionId: "session",
    threadId: "session",
    workspaceId: "workspace",
    deviceId: "device",
    kind: "schedule",
    source: "foundry",
    title: "Older inspection",
    management: "managed",
    desiredState: "enabled",
    revision: 2,
    generation: 1,
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
    spec: { schedule: "28,58 * * * *" },
    observation: {
      status: "idle",
      at: "2026-10-17T00:00:00Z",
      confirmedRevision: 2,
    },
    allowedActions: ["pause", "resume", "stop", "remove", "run"],
    ...overrides,
  };
}
test("controls match lifecycle capabilities and stopped timers do not appear live", () => {
  assert.deepEqual(workActions(work()), ["pause", "stop", "run"]);
  assert.deepEqual(workActions(work({ desiredState: "paused" })), [
    "resume",
    "stop",
    "run",
  ]);
  assert.equal(
    isOutstandingWork(
      work({
        desiredState: "stopped",
        observation: { status: "stopped", confirmedRevision: 2 },
      }),
    ),
    false,
  );
  assert.equal(
    isOutstandingWork(
      work({
        desiredState: "stopped",
        observation: { status: "running", confirmedRevision: 1 },
      }),
    ),
    true,
  );
  assert.equal(isOutstandingWork(work({ management: "observed" })), false);
  assert.ok(
    workActions(
      work({
        kind: "process",
        observation: { status: "completed", confirmedRevision: 2 },
      }),
    ).includes("resume"),
  );
});
test("unassigned sources have their own group and pending controls remain visible", () => {
  const controller = {
    list: {
      items: [
        work(),
        work({
          id: "unassigned",
          title: "Unrelated cron",
          source: "crontab",
          management: "observed",
          allowedActions: ["adopt"],
        }),
      ],
      operations: [
        {
          id: "operation",
          state: "unknown",
          items: [{ id: "work_a", revision: 2 }],
        },
      ],
      coverage: {
        hostSchedules: "partial",
        processes: "managed_native_and_attributed",
      },
      barrier: true,
    },
    refresh: async () => {},
    control: async () => {},
  };
  const html = renderToStaticMarkup(
    createElement(SessionWorkSection, { controller, canControl: true }),
  );
  assert.match(html, /work\.unassigned/);
  assert.match(html, /Unrelated cron/);
  assert.match(html, /work\.receipt/);
  assert.match(html, /work\.barrier/);
  const readonly = renderToStaticMarkup(
    createElement(SessionWorkSection, { controller, canControl: false }),
  );
  assert.doesNotMatch(readonly, /work\.stopAll/);
});

test("a stopped intent with an unknown actual state never reads as confirmed stopped", () => {
  const controller = {
    list: {
      items: [
        work({
          desiredState: "stopped",
          observation: {
            status: "unknown",
            confirmedRevision: 2,
            at: "2026-10-17T00:00:00Z",
            error: "Device state unavailable",
          },
        }),
      ],
      operations: [],
      coverage: { hostSchedules: "partial", processes: "not_observed" },
      barrier: true,
    },
    refresh: async () => {},
    control: async () => {},
  };
  const html = renderToStaticMarkup(
    createElement(SessionWorkSection, { controller, canControl: true }),
  );
  assert.match(html, /work\.pending/);
  assert.match(html, /Device state unavailable/);
  assert.doesNotMatch(html, />work\.stopped</);
});

function renderWork(
  items = [],
  listOverrides = {},
  controllerOverrides = {},
  canControl = true,
) {
  return renderToStaticMarkup(
    createElement(SessionWorkSection, {
      controller: {
        list: {
          items,
          operations: [],
          coverage: {
            hostSchedules: "not_observed",
            processes: "not_observed",
          },
          barrier: false,
          ...listOverrides,
        },
        refresh: async () => {},
        control: async () => {},
        ...controllerOverrides,
      },
      canControl,
    }),
  );
}

test("an empty inventory contributes no heading, controls or discovery placeholder", () => {
  assert.equal(renderWork(), "");
  assert.equal(renderWork([work({ desiredState: "removed" })]), "");
  assert.equal(
    renderWork([], {
      barrier: true,
      operations: [{ id: "old-stop", state: "verified", items: [] }],
    }),
    "",
  );
});

test("an empty visible inventory hides unscoped receipts but keeps read failures", () => {
  const pending = renderWork([], {
    operations: [{ id: "stop", state: "pending", items: [] }],
  });
  assert.equal(pending, "");
  assert.doesNotMatch(pending, /<button/);
  const failed = renderWork([], {}, { error: "Device disconnected" });
  assert.match(failed, /Device disconnected/);
  assert.match(failed, /work\.refresh/);
  assert.doesNotMatch(failed, /work\.(pauseAll|stopAll|empty)/);
});

test("completed and stopped schedules collapse into history while paused schedules remain actionable", () => {
  for (const status of ["stopped", "completed"]) {
    const html = renderWork([
      work({
        desiredState: status === "stopped" ? "stopped" : "enabled",
        observation: { status, confirmedRevision: 2 },
      }),
    ]);
    assert.match(html, /work\.timerHistory/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /<h3>work\.title<\/h3>/);
    assert.doesNotMatch(
      html,
      /work\.group\.schedule|Older inspection|work\.action\./,
    );
  }
  const paused = renderWork([
    work({
      desiredState: "paused",
      observation: { status: "stopped", confirmedRevision: 2 },
    }),
  ]);
  assert.match(paused, /Older inspection/);
  assert.match(paused, /work\.paused/);
  assert.match(paused, /work\.actionsFor/);
  assert.doesNotMatch(paused, /work\.timerHistory/);
});

test("controls have concrete row targets and pending work cannot be prematurely archived or restarted", () => {
  const html = renderWork([work()]);
  assert.match(html, /data-work-id="work_a"/);
  assert.doesNotMatch(html, /work\.(pauseAll|stopAll|coverage)/);
  const stopping = work({
    desiredState: "stopped",
    observation: { status: "running", confirmedRevision: 1 },
  });
  assert.deepEqual(workActions(stopping), []);
  const pausing = work({
    desiredState: "paused",
    observation: { status: "running", confirmedRevision: 1 },
  });
  assert.deepEqual(workActions(pausing), ["stop"]);
  assert.deepEqual(
    workActions(
      work({
        desiredState: "stopped",
        observation: { status: "stopped", confirmedRevision: 2 },
      }),
    ),
    ["resume", "remove"],
  );
});

test("composer count and panel include paused tasks and unresolved errors, excluding confirmed history", () => {
  assert.equal(
    isCurrentWork(
      work({
        desiredState: "paused",
        observation: { status: "stopped", confirmedRevision: 2 },
      }),
    ),
    true,
  );
  assert.equal(
    isCurrentWork(
      work({
        desiredState: "stopped",
        observation: {
          status: "stopped",
          confirmedRevision: 2,
          error: "Verification failed",
        },
      }),
    ),
    true,
  );
  assert.equal(
    isCurrentWork(
      work({
        desiredState: "stopped",
        observation: { status: "stopped", confirmedRevision: 2 },
      }),
    ),
    false,
  );
  assert.equal(isCurrentWork(work({ management: "observed" })), false);
});

test("a failed action offers a real retry, while a read failure offers refresh", () => {
  const controlFailure = renderWork(
    [work()],
    {},
    {
      error: "Response lost",
      controlError: "Response lost",
      controlTargetId: "work_a",
      retryControl: async () => {},
    },
  );
  assert.match(controlFailure, /work\.retryControl/);
  assert.doesNotMatch(controlFailure, /work\.refresh/);
  const readFailure = renderWork(
    [work()],
    {},
    { error: "Inventory unavailable" },
  );
  assert.match(readFailure, /work\.loadFailed/);
  assert.match(readFailure, /work\.refresh/);
  assert.doesNotMatch(readFailure, /work\.retryControl/);
});

test("the sidebar exposes no conversation-wide action, even with multiple visible timers", () => {
  const items = [
    work(),
    work({ id: "second" }),
    work({ id: "hidden", kind: "process" }),
  ];
  const html = renderWork(items);
  assert.doesNotMatch(html, /aria-label="work\.actions"|work\.stopAll/);
  assert.match(html, /data-work-id="work_a"/);
  assert.match(html, /data-work-id="second"/);
  assert.doesNotMatch(html, /data-work-id="hidden"/);
});

test("hidden or mixed-target receipts never leak into timer history", () => {
  const ended = work({
    desiredState: "stopped",
    observation: { status: "stopped", confirmedRevision: 2 },
  });
  const hidden = work({ id: "process", kind: "process" });
  for (const targets of [
    [],
    [{ id: "process" }],
    [{ id: "work_a" }, { id: "process" }],
  ]) {
    const html = renderWork([ended, hidden], {
      operations: [
        { id: "bulk", action: "stop_all", state: "pending", items: targets },
      ],
    });
    assert.match(html, /work\.timerHistory/);
    assert.doesNotMatch(html, /work\.receipt|work\.discoveryPending/);
  }
  assert.match(
    renderWork([ended], {
      operations: [
        {
          id: "single",
          action: "stop",
          state: "pending",
          items: [{ id: "work_a" }],
        },
      ],
    }),
    /work\.receipt/,
  );
});

test("runtime helpers and foreground processes contribute neither task rows nor bulk stop targets", () => {
  for (const processRole of ["runtime", "foreground", undefined]) {
    const item = work({
      source: "process",
      kind: "process",
      observation: { status: "running", confirmedRevision: 1, processRole },
    });
    assert.equal(isCurrentWork(item), false);
    assert.deepEqual(workActions(item), []);
    assert.equal(renderWork([item]), "");
  }
});

test("scheduler readiness is localized without concealing actual execution errors", () => {
  for (const [scheduler, key] of [
    ["not_observed", "schedulerMissing"],
    ["stale", "schedulerStale"],
  ]) {
    const coverage = {
      scheduler,
      schedulerError: "Server readiness diagnostic",
    };
    const item = work({
      observation: {
        status: "unknown",
        confirmedRevision: 0,
        error: coverage.schedulerError,
      },
    });
    const html = renderWork([item], { coverage });
    assert.match(html, new RegExp(`work\\.${key}`));
    assert.doesNotMatch(html, /Server readiness diagnostic/);
    item.observation.error = "A real execution failure";
    assert.match(renderWork([item], { coverage }), /A real execution failure/);
  }
});

test("a recurring definition remains active and stoppable between completed executions", () => {
  const item = work({
    spec: { schedule: "* * * * *", recurring: true },
    observation: { status: "completed", confirmedRevision: 2 },
  });
  assert.equal(isCurrentWork(item), true);
  assert.equal(isOutstandingWork(item), true);
  assert.ok(workActions(item).includes("stop"));
  assert.ok(workActions(item).includes("pause"));
});

test("native subagents remain read-only with a focusable icon naming type and status", () => {
  const item = work({
    kind: "agent",
    source: "codex",
    management: "observed",
    allowedActions: [],
    native: {
      runtime: "codex",
      version: "0.163.0",
      sessionId: "native",
      taskId: "child",
      observation: "available",
      controls: { stop: "unavailable" },
    },
    observation: { status: "running", confirmedRevision: 2 },
  });
  const html = renderWork([item]);
  assert.match(html, /work\.agentsTitle/);
  assert.match(html, /work\.nativeAgent/);
  assert.match(
    html,
    /role="img" aria-label="work\.nativeAgent · work\.status\.running"/,
  );
  assert.match(html, /tabindex="0"/);
  assert.doesNotMatch(html, /aria-haspopup="menu"|work\.unassigned/);
});

test("workspace services stay in inventory but are absent from the conversation sidebar", () => {
  const shared = work({
    kind: "process",
    title: "Protected shared service",
    relatedSessionIds: ["consumer"],
    sharedSessionCount: 1,
  });
  const before = structuredClone(shared);
  const html = renderWork([shared, work({ id: "timer" })]);
  assert.doesNotMatch(
    html,
    /Protected shared service|work\.sharedService|work\.serviceOwner/,
  );
  assert.deepEqual(shared, before);
  assert.equal(renderWork([shared]), "");
});

test("an acknowledged stop intent never hides a still-running execution", () => {
  const item = work({
    desiredState: "stopped",
    observation: { status: "running", confirmedRevision: 2 },
  });
  const html = renderWork([item]);
  assert.match(html, /data-status="pending"/);
  assert.equal(workActions(item).includes("stop"), true);
});

test("work keeps its title for ended-only history and hides an empty section", () => {
  const ended = work({
    desiredState: "stopped",
    observation: { status: "stopped", confirmedRevision: 2 },
  });
  for (const items of [[ended], [work(), { ...ended, id: "ended" }]]) {
    const html = renderWork(items);
    assert.match(html, /<h3>work\.title<\/h3>/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /work\.timerHistory/);
  }
  assert.equal(renderWork([]), "");
});

test("119 mixed records have timer-only counts and separate agent history without mutating inventory", async () => {
  const { mixedSidebarInventory } =
    await import("./fixtures/timer-sidebar-data.ts");
  const items = mixedSidebarInventory();
  const before = structuredClone(items);
  assert.equal(items.length, 119);
  assert.deepEqual(sidebarWorkCounts(items), { timers: 2, agents: 2 });
  assert.equal(items.filter(isSidebarWork).length, 7);
  const html = renderWork(items);
  const timerSection = html.match(
    /<section[^>]+data-work-kind="schedule"[^>]*>([\s\S]*?)<\/section>/,
  )?.[1];
  const agentSection = html.match(
    /<section[^>]+data-work-kind="agent"[^>]*>([\s\S]*?)<\/section>/,
  )?.[1];
  assert.ok(timerSection && agentSection);
  assert.match(timerSection, /timer-active|timer-native/);
  assert.match(timerSection, /work\.timerHistory/);
  assert.doesNotMatch(
    timerSection,
    /agent-child|agent-native|work\.agentHistory/,
  );
  assert.match(agentSection, /agent-child|agent-native/);
  assert.match(agentSection, /work\.agentHistory/);
  assert.doesNotMatch(agentSection, /timer-active|work\.timerHistory/);
  assert.doesNotMatch(
    html,
    /command-\d+|Workspace durable service|work\.stopAll|aria-label="work\.actions"/,
  );
  assert.deepEqual(items, before);
  const commandsOnly = items.filter((item) => item.kind === "process");
  assert.equal(renderWork(commandsOnly), "");
  assert.deepEqual(sidebarWorkCounts(commandsOnly), { timers: 0, agents: 0 });
});

test("errors for hidden control targets do not offer a retry in the timer panel", () => {
  const html = renderWork(
    [work(), work({ id: "hidden-service", kind: "process" })],
    {},
    {
      error: "Hidden service control failed",
      controlError: "Hidden service control failed",
      controlTargetId: "hidden-service",
    },
  );
  assert.doesNotMatch(html, /Hidden service control failed|work\.retryControl/);
});
