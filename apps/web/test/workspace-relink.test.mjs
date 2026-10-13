import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "http://foundry.test/locations" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
await import("../src/i18n/index.ts");
const { WorkspaceSelectionPanel } =
  await import("../src/features/workspaces/workspace-selection-panel.tsx");

const device = { id: "mac", label: "Mac", status: "connected", owned: true };
const missing = {
  id: "ws-moved",
  name: "foundry",
  localPath: "/Users/dev/foundry",
  deviceId: "mac",
  unavailableOnDevice: { reason: "folder_missing", since: "x" },
};
const other = {
  id: "ws-other",
  name: "other",
  localPath: "/Users/dev/other",
  deviceId: "mac",
};

async function render(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes = [];
  await act(async () =>
    root.render(
      createElement(WorkspaceSelectionPanel, {
        activeWorkspaceId: missing.id,
        busyWorkspaceId: "",
        error: "",
        devices: [device],
        workspaces: [missing, other],
        onReset: () => {},
        onSelect: async () => true,
        onPrepare: () => {},
        onPrepareEnd: () => {},
        onOpenDevice: () => {},
        onBrowse: () => {},
        onReturn: () => {},
        onAddAgain: async () => {},
        onChanged: async (change) => {
          changes.push(change);
        },
        ...props,
      }),
    ),
  );
  return {
    container,
    changes,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const byText = (selector, text) =>
  [...document.querySelectorAll(selector)].find(
    (node) => node.textContent.trim() === text,
  );
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
const submit = () =>
  act(async () =>
    document
      .querySelector('[role="dialog"] form')
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );

test("a missing folder says so on its row and is located by Locate folder", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, method: options.method ?? "GET", body: options.body });
    if (url.includes("/relink-suggestions"))
      return Response.json({
        suggestions: [
          { path: "/Users/dev/foundry-renamed", reason: "same_workspace" },
          { path: "/Users/dev/fork", reason: "same_git_remote" },
        ],
      });
    if (url.includes("/api/workspaces/subdirectories"))
      return Response.json([]);
    if (url.endsWith("/relink"))
      return Response.json({
        workspace: { ...missing, localPath: "/Users/dev/foundry-renamed" },
        nativeSessions: { copied: 2, alreadyThere: 1, notFound: 1 },
      });
    return Response.json({});
  });
  const view = await render();
  try {
    const row = [
      ...view.container.querySelectorAll(".fdy-location-workspace-row"),
    ].find((node) => node.textContent.includes("foundry"));
    assert.equal(row.getAttribute("data-folder-missing"), "true");
    assert.equal(row.getAttribute("data-unserved"), null);
    assert.match(row.textContent, /\/Users\/dev\/foundry/);
    assert.match(
      row.querySelector(".fdy-location-unserved-note").textContent,
      /^Folder not found on Mac at this path/,
    );
    // Still current; no Add again (the device still has the workspace).
    assert.match(row.textContent, /Current/);
    assert.equal(byText("button", "Add again"), undefined);

    const locate = byText("button", "Locate folder…");
    assert.equal(
      locate.getAttribute("aria-label"),
      "Locate the folder of foundry on Mac",
    );
    await act(async () => locate.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Locate folder/);
    assert.match(
      dialog.textContent,
      /keeps its chats, sessions, Issues and settings\. Its last known folder was \/Users\/dev\/foundry on Mac/,
    );
    const field = dialog.querySelector("input");
    assert.equal(field.value, "/Users/dev/", "starts beside the old folder");
    const choice = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent.includes("/Users/dev/foundry-renamed"),
    );
    assert.match(
      choice.textContent,
      /Contains this workspace's Foundry identity/,
    );
    assert.equal(choice.getAttribute("aria-pressed"), "false");
    await act(async () => choice.click());
    assert.equal(
      dialog.querySelector("input").value,
      "/Users/dev/foundry-renamed",
    );
    assert.equal(choice.getAttribute("aria-pressed"), "true");
    await submit();
    const relink = calls.find((call) => call.url.endsWith("/relink"));
    assert.equal(relink.method, "POST");
    assert.match(relink.url, /\/api\/workspaces\/ws-moved\/relink$/);
    assert.deepEqual(JSON.parse(relink.body), {
      path: "/Users/dev/foundry-renamed",
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(view.changes, [undefined]);
    assert.equal(
      view.container.querySelector('[role="status"]').textContent,
      "Located “foundry” at /Users/dev/foundry-renamed. 2 chats can resume in that folder. 1 chat will continue in a new native session with its Foundry conversation.",
    );
  } finally {
    await view.cleanup();
  }
});

test("a folder no longer served offers Locate folder beside Add again", async () => {
  const view = await render({
    activeWorkspaceId: other.id,
    workspaces: [
      {
        ...missing,
        unavailableOnDevice: { reason: "not_served", since: "x" },
      },
      other,
    ],
  });
  try {
    const row = [
      ...view.container.querySelectorAll(".fdy-location-workspace-row"),
    ].find((node) => node.textContent.includes("foundry"));
    const labels = [...row.querySelectorAll("button")].map((button) =>
      button.textContent.trim(),
    );
    assert.ok(labels.includes("Add again"));
    assert.ok(labels.includes("Locate folder…"));
    assert.ok(labels.indexOf("Add again") < labels.indexOf("Locate folder…"));
  } finally {
    await view.cleanup();
  }
});

test("with nothing selected the page asks to Switch and offers no way back", async () => {
  const view = await render({ activeWorkspaceId: "" });
  try {
    assert.match(
      view.container.querySelector(".fdy-location-current").textContent,
      /No workspace selected.*Choose a workspace below and Switch to it\./,
    );
    assert.equal(byText("button", "Back to workspace"), undefined);
  } finally {
    await view.cleanup();
  }
});

test("with no workspace selected, reads ask for none and a reload keeps it so", async (t) => {
  const {
    clearWorkspaceSelection,
    initialWorkspaceId,
    persistWorkspaceId,
    workspaceToRead,
  } = await import("../src/app/navigation.ts");
  localStorage.clear();
  // A first visit: the server shows the first workspace there is.
  assert.equal(workspaceToRead(""), "");
  persistWorkspaceId("ws-a", 2);
  assert.equal(initialWorkspaceId(""), "ws-a");
  assert.equal(workspaceToRead("ws-a"), "ws-a");

  clearWorkspaceSelection();
  assert.equal(initialWorkspaceId(""), "", "the sentinel is not an id");
  assert.equal(workspaceToRead(""), "none");
  // A field read answers no workspace list: nothing changes.
  persistWorkspaceId("");
  assert.equal(workspaceToRead(""), "none");
  // None shown while some exist stays none.
  persistWorkspaceId("", 3);
  assert.equal(workspaceToRead(""), "none");
  // None left: the next folder added is shown again.
  persistWorkspaceId("", 0);
  assert.equal(workspaceToRead(""), "");
  // Switching picks one.
  clearWorkspaceSelection();
  persistWorkspaceId("ws-b", 2);
  assert.equal(initialWorkspaceId(""), "ws-b");

  // A workspace gone from the server is not replaced by another.
  const reads = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    reads.push(String(input));
    return reads.length === 1
      ? Response.json({ error: "not found" }, { status: 404 })
      : Response.json({ workspace: { id: "" }, workspaces: [] });
  });
  const { loadFoundryData } = await import("../src/api.ts");
  const result = await loadFoundryData("ws-gone");
  assert.equal(result.data.workspace.id, "");
  assert.equal(
    new URL(reads[1]).searchParams.get("workspaceId"),
    "none",
    "the read after a 404 asks for no workspace",
  );
  localStorage.clear();
});
