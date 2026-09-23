import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);
const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
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
const { WorkspaceEditor } =
  await import("../src/features/devices/workspace-editor.tsx");
const workspace = {
  id: "ws-test",
  name: "Original",
  deviceId: "device-test",
  localPath: "/preserved/folder",
};
async function setup(edit, activeWorkspaceId = "other") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved = [];
  let closed = 0;
  await act(() =>
    root.render(
      createElement(WorkspaceEditor, {
        edit,
        activeWorkspaceId,
        device: {
          id: "device-test",
          label: "Test device",
          status: "connected",
        },
        onClose: () => closed++,
        onSaved: async (...args) => saved.push(args),
      }),
    ),
  );
  return {
    saved,
    closed: () => closed,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}
async function input(value) {
  const field = document.querySelector("input");
  await act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(field, value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const submit = async () =>
  act(() =>
    document
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );

test("registration is device scoped, keeps the dialog on failure and never emits activation", async () => {
  const original = globalThis.fetch;
  const calls = [];
  let fail = true;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    return new Response(
      JSON.stringify(fail ? { error: "Folder unavailable" } : workspace),
      { status: fail ? 400 : 201 },
    );
  };
  const view = await setup({ kind: "add" });
  try {
    await input("/preserved/folder");
    await submit();
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Folder unavailable/,
    );
    assert.equal(document.querySelector("input").value, "/preserved/folder");
    assert.equal(view.closed(), 0);
    fail = false;
    await submit();
    assert.deepEqual(JSON.parse(calls[1].body), {
      deviceId: "device-test",
      path: "/preserved/folder",
    });
    assert.equal(view.saved[0][0], "add");
    assert.equal(view.closed(), 1);
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});
test("rename sends only a display name, not a folder mutation", async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), ...options };
    return new Response(JSON.stringify({ ...workspace, name: "Friendly" }));
  };
  const view = await setup({ kind: "rename", workspace });
  try {
    await input("Friendly");
    await submit();
    assert.equal(request.method, "PATCH");
    assert.deepEqual(JSON.parse(request.body), { name: "Friendly" });
    assert.equal(view.saved[0][0], "rename");
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});
test("current workspace removal is blocked, with explicit history and local-file semantics", async () => {
  const view = await setup({ kind: "remove", workspace }, workspace.id);
  try {
    assert.match(document.body.textContent, /Chats, issues and run history/);
    assert.match(document.body.textContent, /Local files will not be deleted/);
    assert.match(document.body.textContent, /Switch to another workspace/);
    assert.equal(
      document.querySelector('button[type="submit"]').disabled,
      true,
    );
    await submit();
    assert.deepEqual(view.saved, []);
  } finally {
    await view.cleanup();
  }
});

test("inactive removal reports failures, retries explicitly, and returns the removed identity without choosing another workspace", async () => {
  const original = globalThis.fetch;
  let fail = true;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(
      JSON.stringify(fail ? { error: "workspace has active work" } : workspace),
      { status: fail ? 409 : 200 },
    );
  };
  const view = await setup({ kind: "remove", workspace });
  try {
    await submit();
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /active work/,
    );
    assert.equal(view.closed(), 0);
    fail = false;
    await submit();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "DELETE");
    assert.match(calls[1].url, /\/api\/workspaces\/ws-test$/);
    assert.deepEqual(view.saved, [["remove", workspace]]);
    assert.equal(view.closed(), 1);
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});

const folders = [
  { id: "dir-1", name: "projects", path: "/Users/dev/projects" },
  { id: "dir-2", name: "documents", path: "/Users/dev/documents" },
];

function stubFolders(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes("/api/workspaces/subdirectories"))
      return new Response(JSON.stringify(folders), { status: 200 });
    return new Response(JSON.stringify(workspace), { status: 201 });
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

async function key(name) {
  const field = document.querySelector("input");
  await act(async () => {
    field.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });
}

test("typing a folder suggests its subfolders; picking one drills into it", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = stubFolders(calls);
  const view = await setup({ kind: "add" });
  try {
    await input("/Users/dev/pro");
    await settle();
    const lookup = calls.find((call) =>
      call.url.includes("/api/workspaces/subdirectories"),
    );
    assert.equal(JSON.parse(lookup.body).path, "/Users/dev");
    const options = [...document.querySelectorAll('[role="option"]')];
    const names = options.map((option) => option.textContent);
    assert.ok(names.some((name) => name.includes("projects")));
    assert.ok(
      !names.some((name) => name.includes("documents")),
      "suggestions follow the typed name",
    );
    assert.ok(
      document.querySelector('input[role="combobox"]'),
      "the field is an accessible combobox",
    );
    await act(async () =>
      options
        .find((option) => option.textContent.includes("projects"))
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
    assert.equal(document.querySelector("input").value, "/Users/dev/projects/");
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});

test("Enter registers the typed path unless the arrow keys chose a suggestion", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = stubFolders(calls);
  const view = await setup({ kind: "add" });
  try {
    await input("/Users/dev/");
    await settle();
    await key("ArrowDown");
    await key("Enter");
    assert.equal(
      document.querySelector("input").value,
      "/Users/",
      "the first ArrowDown lands on '..'; Enter drills there",
    );
    await input("/Users/dev/projects");
    await settle();
    await key("Enter");
    await settle();
    const created = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/workspaces"),
    );
    assert.ok(created, "Enter without navigation submits the form");
    assert.equal(JSON.parse(created.body).path, "/Users/dev/projects");
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});

test("a bare folder name is looked up in the home folder", async () => {
  const { workspacePathLookup, matchesFolderQuery } =
    await import("../src/features/devices/workspace-path-lookup.ts");
  assert.deepEqual(workspacePathLookup("proj"), {
    lookupPath: "~",
    query: "proj",
  });
  assert.deepEqual(workspacePathLookup("/"), {
    lookupPath: "/",
    parentPath: undefined,
    query: "",
  });
  assert.equal(workspacePathLookup("  "), undefined);
  assert.equal(matchesFolderQuery("projects", "PRJ"), true);
  assert.equal(matchesFolderQuery("projects", "jp"), false);
});

test("suggestions from a new folder fully replace the old ones even when device ids collide", async () => {
  const original = globalThis.fetch;
  // The device derives ids by folding punctuation, so distinct folders such
  // as "a-b" and "a--b" can share one.
  globalThis.fetch = async (url, options = {}) => {
    const { path } = JSON.parse(options.body ?? "{}");
    const listing =
      path === "/x"
        ? [
            { id: "dir_x_a_b", name: "a-b", path: "/x/a-b" },
            { id: "dir_x_a_b", name: "a--b", path: "/x/a--b" },
          ]
        : [
            { id: "dir_y_b", name: "b", path: "/y/b" },
            { id: "dir_x_a_b", name: "c", path: "/y/c" },
          ];
    return new Response(JSON.stringify(listing), { status: 200 });
  };
  const view = await setup({ kind: "add" });
  try {
    await input("/x/");
    await settle();
    await input("/y/");
    await settle();
    const values = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.getAttribute("data-value"),
    );
    assert.deepEqual(values, ["/", "/y/b", "/y/c"]);
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});
