import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach } from "node:test";
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
  "HTMLButtonElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
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
const { createRoot: createReactRoot } = await import("react-dom/client");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const mountedRoots = new Set();
afterEach(async () => {
  await act(async () => {
    for (const root of [...mountedRoots]) root.unmount();
  });
  document.body.replaceChildren();
});
function createRoot(container) {
  const root = createReactRoot(container);
  const wrapped = {
    render: (node) => root.render(createElement(ToastProvider, null, node)),
    unmount: () => {
      if (!mountedRoots.has(wrapped)) return;
      document
        .querySelectorAll(".fdy-toast-close")
        .forEach((button) => button.click());
      root.unmount();
      mountedRoots.delete(wrapped);
    },
  };
  mountedRoots.add(wrapped);
  return wrapped;
}
const { i18n } = await import("../src/i18n/index.ts");
const { createIssue, workspaceNeedsGit } = await import("../src/api.ts");
const { InitializeGitDialog } =
  await import("../src/features/issues/initialize-git-dialog.tsx");
const { useIssueCreation } =
  await import("../src/features/issues/use-issue-creation.ts");

const copy =
  "Issues need Git. Foundry will run git init in /home/me/notes (if needed), keep its own files out of Git through .git/info/exclude, and commit the folder's current files as the first commit.";

test("creating an Issue in a workspace without Git is refused until the person confirms", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.initializeGit
      ? new Response(JSON.stringify({ id: "iss_1" }), { status: 201 })
      : new Response(
          JSON.stringify({
            error: "this workspace needs Git first; confirm to initialize",
            code: "workspace_needs_git",
            path: "/home/me/notes",
          }),
          { status: 409 },
        );
  });
  const input = { sourceInput: "Fix the README", workspaceId: "ws_git" };
  const refusal = await createIssue(input).catch((error) => error);
  assert.equal(workspaceNeedsGit(refusal), true);
  assert.equal(
    refusal.message,
    "this workspace needs Git first; confirm to initialize",
  );
  const issue = await createIssue({ ...input, initializeGit: true });
  assert.equal(issue.id, "iss_1");
  assert.deepEqual(
    bodies.map((body) => body.initializeGit),
    [undefined, true],
  );
  // Any other refusal is not mistaken for it.
  assert.equal(workspaceNeedsGit(new Error("offline")), false);
});

async function renderDialog(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(createElement(InitializeGitDialog, props)));
  const button = (text) =>
    [...document.querySelectorAll("button")].find(
      (row) => row.textContent.trim() === text,
    );
  return {
    button,
    click: async (text) => {
      assert.ok(button(text), `button ${text}`);
      await act(() => button(text).click());
    },
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

test("the Git setup dialog says exactly what happens; Cancel does nothing else", async () => {
  await i18n.changeLanguage("en");
  const calls = [];
  const view = await renderDialog({
    path: "/home/me/notes",
    onConfirm: async () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });
  const dialog = document.querySelector("[role=dialog]");
  assert.ok(dialog);
  assert.match(dialog.textContent, /Set up Git for Issues/);
  assert.ok(dialog.textContent.includes(copy));
  await view.click("Cancel");
  assert.deepEqual(calls, ["cancel"]);
  await view.click("Confirm");
  assert.deepEqual(calls, ["cancel", "confirm"]);
  await view.cleanup();
});

test("a failed Git setup stays in the dialog with its reason", async () => {
  await i18n.changeLanguage("zh-CN");
  const view = await renderDialog({
    path: "/home/me/notes",
    onConfirm: async () => {
      throw new Error("Setting up Git failed: disk full");
    },
    onCancel: () => {},
  });
  assert.match(
    document.querySelector("[role=dialog]").textContent,
    /Issue 需要 Git。Foundry 将在 \/home\/me\/notes 中运行 git init/,
  );
  await view.click("确认");
  assert.equal(
    document.querySelector('.fdy-toast[data-tone="error"]').textContent,
    "Setting up Git failed: disk full",
  );
  assert.equal(view.button("确认").disabled, false);
  await view.cleanup();
  await i18n.changeLanguage("en");
});

test("the Issues page flow: refused, asked, cancelled with nothing changed, then confirmed", async (t) => {
  await i18n.changeLanguage("en");
  const bodies = [];
  let gitReady = false;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.initializeGit) gitReady = true;
    return gitReady
      ? new Response(JSON.stringify({ id: `iss_${bodies.length}` }), {
          status: 201,
        })
      : new Response(
          JSON.stringify({
            error: "this workspace needs Git first; confirm to initialize",
            code: "workspace_needs_git",
          }),
          { status: 409 },
        );
  });
  const created = [];
  let creation;
  function Page() {
    creation = useIssueCreation(async (issue) => created.push(issue.id));
    return creation.gitSetupPending
      ? createElement(InitializeGitDialog, {
          path: "/home/me/notes",
          onCancel: creation.cancelGitSetup,
          onConfirm: creation.confirmGitSetup,
        })
      : null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(createElement(Page)));
  const click = async (text) => {
    const button = [...document.querySelectorAll("button")].find(
      (row) => row.textContent.trim() === text,
    );
    assert.ok(button, `button ${text}`);
    await act(() => button.click());
  };
  const input = { sourceInput: "Fix the README", workspaceId: "ws_git" };

  let done;
  await act(async () => {
    done = await creation.create(input);
  });
  assert.equal(done, false);
  assert.ok(document.querySelector("[role=dialog]").textContent.includes(copy));
  await click("Cancel");
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.deepEqual(created, []);
  assert.equal(bodies.length, 1, "cancelling sends nothing");

  await act(async () => {
    done = await creation.create(input);
  });
  await click("Confirm");
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.deepEqual(created, ["iss_3"]);
  assert.deepEqual(
    bodies.map((body) => body.initializeGit),
    [undefined, undefined, true],
  );
  assert.equal(bodies[2].sourceInput, "Fix the README");
  await act(() => root.unmount());
  container.remove();
});
