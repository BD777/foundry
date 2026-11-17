import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/project" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

/** The diff worker, run in-process: happy-dom has no Worker. */
class InlineDiffWorker {
  postMessage() {
    setTimeout(() => this.onmessage?.({ data: { patch: "" } }));
  }
  terminate() {}
}
globalThis.Worker = InlineDiffWorker;
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

const hour = 3_600_000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const finding = (summary, sourceRefs) => ({
  kind: "duplicate",
  summary,
  sourceRefs,
});
const reviewA = {
  id: "mnt_a",
  role: "project",
  workspaceId: "ws_1",
  eventKey: "e1",
  status: "review",
  revision: 1,
  attempt: 1,
  sessionId: "sess_review",
  dueAt: iso(-2 * hour),
  createdAt: iso(-2 * hour),
  updatedAt: iso(-1 * hour),
  result: {
    summary:
      "AGENTS.md is within budget and its rules agree, but two facts are written twice. " +
      "The intro and the first bullet both say where the file is edited, and the escalation rule sits under the wrong section. " +
      "One patch removes the repetition and adds no new content.",
    findings: [
      finding(
        "The editing location appears in the intro and again in the first bullet of 「通道的事实」. Keep it in the intro and delete the copy so each fact appears once.",
        ["AGENTS.md#intro@6960ab19", "AGENTS.md#通道的事实@6960ab19"],
      ),
      finding(
        "How to escalate is described under both 「信任边界」 and 「续聊的事实」. The escalation rule belongs with trust boundaries; the follow-up facts stay where they are.",
        ["AGENTS.md#信任边界@6960ab19", "AGENTS.md#续聊的事实@6960ab19"],
      ),
      finding(
        "「处理原则」 still holds placeholder text, so agents fall back to escalating whenever they are unsure. Only the person can fill it in.",
        ["AGENTS.md#处理原则@6960ab19"],
      ),
    ],
    patches: [
      {
        path: "AGENTS.md",
        baseHash: "h0",
        content: "The intro without the repeated line.\n",
        reason:
          "Removes only the repeated text and keeps the read-only fact where it was first stated.",
      },
      {
        path: "README.md",
        baseHash: "missing",
        content: "A fresh README.\n",
        reason: "Adds a README the project never had.",
      },
    ],
  },
};
const reviewB = {
  ...reviewA,
  id: "mnt_b",
  eventKey: "e2",
  revision: 3,
  sessionId: undefined,
  createdAt: iso(-26 * hour),
  updatedAt: iso(-25 * hour),
  result: {
    summary:
      "CLAUDE.md points at AGENTS.md and adds nothing of its own, so no change is needed there.",
    findings: [
      finding("The bridge file stays as it is.", ["CLAUDE.md#bridge@11111111"]),
    ],
    patches: [],
  },
};
const failedC = {
  id: "mnt_c",
  role: "project",
  workspaceId: "ws_1",
  eventKey: "e3",
  status: "failed",
  reason: "maintenance_busy",
  revision: 2,
  attempt: 1,
  dueAt: iso(-3 * 24 * hour),
  createdAt: iso(-3 * 24 * hour),
  updatedAt: iso(-3 * 24 * hour),
};
const completeD = {
  ...failedC,
  id: "mnt_d",
  eventKey: "e4",
  status: "complete",
  reason: undefined,
  createdAt: iso(-9 * 24 * hour),
  updatedAt: iso(-9 * 24 * hour),
  result: {
    summary: "An older review found nothing to change.",
    findings: [],
    patches: [],
  },
};
const jobs = [reviewA, reviewB, failedC, completeD];
const patches = [
  {
    id: "pat_b",
    jobId: "mnt_b",
    workspaceId: "ws_1",
    deviceId: "dev_1",
    index: 0,
    path: "CLAUDE.md",
    baseHash: "h9",
    hash: "h9",
    status: "applied",
    revision: 3,
    createdAt: iso(-26 * hour),
    updatedAt: iso(-24 * hour),
  },
];

const calls = [];
const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/api/workspaces/ws_1/upkeep")
    return json({ jobs, patches });
  calls.push({
    method,
    path: url.pathname,
    body: init.body ? JSON.parse(init.body) : undefined,
  });
  if (url.pathname.endsWith("/patch")) return json(previewReply);
  return json(reviewA);
};
const previewReply = {
  operationId: "op_1",
  path: "AGENTS.md",
  hash: "h0",
  content: "The intro with the repeated line.\n",
  state: "ready",
};

const { createRoot: createReactRoot } = await import("react-dom/client");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { WorkspaceUpkeep } =
  await import("../src/features/workspaces/workspace-upkeep.tsx");
const workspace = {
  id: "ws_1",
  name: "Foundry",
  localPath: "/tmp/foundry",
  baseline: "main",
  contextSummary: "",
  acceptedCount: 0,
  resolvedCount: 0,
  accessRole: "owner",
};

let root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function settle() {
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render() {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createReactRoot(container);
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(WorkspaceUpkeep, { workspace }),
      ),
    ),
  );
  await settle();
  return container;
}

const toggleFor = (container, id) =>
  container.querySelector(`[aria-controls="upkeep-review-${id}"]`);

async function openRowMenu(container, label) {
  const trigger = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  assert.ok(trigger, `no row menu "${label}"`);
  await act(async () => {
    trigger.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    trigger.click();
  });
  await settle();
  return [...document.querySelectorAll('[role="menuitem"]')];
}

test("reviews are rows: newest open, the rest collapsed, three then all", async () => {
  const container = await render();
  assert.equal(container.querySelectorAll(".fdy-upkeep-row").length, 3);
  assert.match(container.textContent, /2 suggested changes waiting/);

  // The newest review with undecided suggestions is open; the older one is not.
  assert.equal(
    toggleFor(container, "mnt_a").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(
    toggleFor(container, "mnt_b").getAttribute("aria-expanded"),
    "false",
  );
  assert.ok(container.querySelector("#upkeep-review-mnt_a"));
  assert.equal(container.querySelector("#upkeep-review-mnt_b"), null);
  // The body starts after the sentence the row already shows.
  const summary = container.querySelector(
    "#upkeep-review-mnt_a .fdy-clamped-text p",
  );
  assert.match(summary.textContent, /^The intro and the first bullet/);
  assert.ok(!summary.textContent.startsWith("AGENTS.md is within budget"));
  // Findings carry file and section only; the version hash is dropped.
  assert.match(container.textContent, /AGENTS\.md › 通道的事实/);
  assert.match(container.textContent, /2 suggestions/);

  await act(async () => toggleFor(container, "mnt_b").click());
  assert.equal(
    toggleFor(container, "mnt_b").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(
    toggleFor(container, "mnt_a").getAttribute("aria-expanded"),
    "false",
  );

  const showAll = [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === "Show all 4",
  );
  assert.ok(showAll, "no show-all control");
  await act(async () => showAll.click());
  assert.equal(container.querySelectorAll(".fdy-upkeep-row").length, 4);
});

test("a waiting or failed review is one row with its reason and no detail", async () => {
  const container = await render();
  const row = [...container.querySelectorAll(".fdy-upkeep-row")].find((node) =>
    node.textContent.includes("Review failed"),
  );
  assert.ok(row);
  assert.match(row.textContent, /Another maintenance review is active/);
  assert.equal(row.querySelectorAll("button[aria-controls]").length, 0);
});

test("row menu retry and dismiss call the same upkeep actions", async () => {
  const container = await render();
  const items = await openRowMenu(container, "Actions for “Review failed”");
  const dismiss = items.find((item) => item.textContent.trim() === "Dismiss");
  assert.ok(dismiss);
  await act(async () => dismiss.click());
  await settle();
  const call = calls.find(
    (entry) =>
      entry.method === "POST" &&
      entry.path === "/api/workspaces/ws_1/upkeep/mnt_c",
  );
  assert.deepEqual(call.body, { revision: 2, action: "dismiss" });
});

test("review change previews the patch, and Apply sends the reviewed hash", async () => {
  const container = await render();
  const review = [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === "Review change",
  );
  assert.ok(review);
  await act(async () => review.click());
  await settle();
  const preview = calls.find(
    (entry) =>
      entry.path === "/api/workspaces/ws_1/upkeep/mnt_a/patch" &&
      entry.body?.action === "preview",
  );
  assert.deepEqual(preview.body, { revision: 1, index: 0, action: "preview" });

  const apply = [...document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === "Apply",
  );
  assert.ok(apply, "no Apply in the diff footer");
  await act(async () => apply.click());
  await settle();
  const applied = calls.find(
    (entry) =>
      entry.path === "/api/workspaces/ws_1/upkeep/mnt_a/patch" &&
      entry.body?.action === "apply",
  );
  assert.deepEqual(applied.body, {
    revision: 1,
    index: 0,
    action: "apply",
    reviewedHash: "h0",
  });
});
