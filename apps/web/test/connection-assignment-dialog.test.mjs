import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";

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
    value:
      key === "window" || key === "document" || key === "navigator"
        ? window[key]
        : window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { createRoot } = await import("react-dom/client");
const { ConnectionAssignmentDialog } =
  await import("../src/features/devices/connection-assignment-dialog.tsx");

const connections = [
  {
    authMode: "custom",
    baseUrl: "https://relay.test/v1",
    connectionType: "openai_compatible",
    hasCredential: true,
    id: "p1",
    label: "Relay",
    model: "gpt-5",
    runtime: "codex",
  },
  {
    authMode: "custom",
    baseUrl: "http://gateway.internal/v1",
    connectionType: "openai_compatible",
    hasCredential: false,
    id: "p2",
    label: "LLM Gateway",
    model: "flux/gpt-6",
    runtime: "codex",
  },
  {
    authMode: "custom",
    baseUrl: "https://claude-gw.test",
    connectionType: "anthropic_compatible",
    hasCredential: true,
    id: "p3",
    label: "Claude GW",
    model: "claude-sonnet-4-5",
    runtime: "claude",
  },
];

async function renderDialog(props = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const saves = [];
  const openChanges = [];
  const manage = [];
  let onSaveImpl = props.onSaveImpl ?? (async () => {});
  const render = (patch = {}) =>
    act(async () => {
      root.render(
        createElement(ConnectionAssignmentDialog, {
          connections,
          initialSelectedIds: ["p1"],
          open: true,
          onManage: () => manage.push(1),
          onOpenChange: (open) => openChanges.push(open),
          onSave: (ids) => {
            saves.push([...ids]);
            return onSaveImpl([...ids]);
          },
          ...patch,
        }),
      );
    });
  await render();
  return {
    container,
    manage,
    openChanges,
    saves,
    setOnSave: (fn) => {
      onSaveImpl = fn;
    },
    root: () => root,
    render,
    unmount: () => act(async () => root.unmount()),
  };
}

function labelFor(id) {
  return connections.find((connection) => connection.id === id)?.label ?? "";
}

function buttonWith(text) {
  return [...window.document.querySelectorAll("button")].find((button) =>
    button.textContent.includes(text),
  );
}

function rowFor(id) {
  const label = labelFor(id);
  return [
    ...window.document.querySelectorAll(".fdy-connection-assign-row"),
  ].find((row) => row.textContent.includes(label));
}

function checkboxFor(id) {
  return rowFor(id)?.querySelector("input[type='checkbox']");
}

test("opens with the persisted set preselected and an explicit selected state", async () => {
  const view = await renderDialog();
  assert.equal(checkboxFor("p1").checked, true);
  assert.equal(checkboxFor("p2").checked, false);
  assert.match(rowFor("p1").textContent, /Selected for this device/);
  assert.match(rowFor("p2").textContent, /Not selected/);
  assert.equal(rowFor("p1").getAttribute("data-selected"), "true");
  assert.equal(rowFor("p1").classList.contains("is-selected"), true);
  // Nothing changed yet, so Save is disabled.
  assert.equal(buttonWith("Save").disabled, true);
  await view.unmount();
});

test("toggles edit only a local draft; cancel writes nothing and reopens reset", async () => {
  const view = await renderDialog();
  await act(async () => checkboxFor("p2").click());
  assert.equal(checkboxFor("p2").checked, true);
  assert.deepEqual(view.saves, []);

  await act(async () => buttonWith("Cancel").click());
  assert.deepEqual(view.saves, []);
  assert.deepEqual(view.openChanges.at(-1), false);

  // Reopening re-arms from the persisted set: the cancelled toggle is gone.
  await view.render({ open: false });
  await view.render({ open: true });
  assert.equal(checkboxFor("p1").checked, true);
  assert.equal(checkboxFor("p2").checked, false);
  await view.unmount();
});

test("save submits the full resulting set once and closes on success", async () => {
  const view = await renderDialog();
  await act(async () => checkboxFor("p2").click());
  await act(async () => checkboxFor("p1").click());
  await act(async () => buttonWith("Save").click());
  assert.equal(view.saves.length, 1);
  // The dialog submits exactly its draft: p1 removed, p2 added; p3 was never
  // selected so it is not added by the dialog (legacy preservation happens in
  // the deviceConnectionSelection wrapper, covered separately).
  assert.deepEqual([...view.saves[0]].sort(), ["p2"]);
  assert.deepEqual(view.openChanges.at(-1), false);
  await view.unmount();
});

test("busy blocks a second submit and every control", async () => {
  let release;
  const view = await renderDialog({
    onSaveImpl: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await act(async () => checkboxFor("p2").click());
  const save = buttonWith("Save");
  await act(async () => save.click());
  // While pending the controls are busy.
  assert.equal(save.disabled, true);
  for (const input of window.document.querySelectorAll(
    "input[type='checkbox']",
  ))
    assert.equal(input.disabled, true);
  await act(async () => save.click());
  assert.equal(view.saves.length, 1);
  await act(async () => release());
  await view.unmount();
});

test("a failed save keeps the draft, shows the error, and can be retried", async () => {
  let fail = true;
  const view = await renderDialog({
    onSaveImpl: async () => {
      if (fail) throw new Error("network down");
    },
  });
  await act(async () => checkboxFor("p2").click());
  await act(async () => buttonWith("Save").click());
  assert.equal(view.saves.length, 1);
  const alert = window.document.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /network down/);
  // The dialog stayed open and the draft survived.
  assert.equal(checkboxFor("p2").checked, true);
  assert.deepEqual(view.openChanges, []);

  fail = false;
  await act(async () => buttonWith("Save").click());
  assert.equal(view.saves.length, 2);
  assert.deepEqual(view.openChanges.at(-1), false);
  await view.unmount();
});

test("an external binding change while open never wipes the user's draft", async () => {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let setExternal;
  function Host() {
    const [external, setValue] = useState(["p1"]);
    setExternal = setValue;
    return createElement(ConnectionAssignmentDialog, {
      connections,
      initialSelectedIds: external,
      open: true,
      onManage: () => {},
      onOpenChange: () => {},
      onSave: async () => {},
    });
  }
  await act(async () => root.render(createElement(Host)));
  try {
    // User makes an unsaved change.
    await act(async () => checkboxFor("p2").click());
    assert.equal(checkboxFor("p2").checked, true);

    // A background snapshot changes the persisted set mid-edit (p1 dropped
    // server-side, arriving as a fresh array reference).
    await act(async () => setExternal([]));
    assert.equal(checkboxFor("p1").checked, true, "draft keeps user's p1");
    assert.equal(checkboxFor("p2").checked, true, "draft keeps new p2 choice");
  } finally {
    await act(async () => root.unmount());
  }
});

test("an empty catalog offers the management page and never an enabled save", async () => {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const manage = [];
  await act(async () => {
    root.render(
      createElement(ConnectionAssignmentDialog, {
        connections: [],
        initialSelectedIds: [],
        open: true,
        onManage: () => manage.push(1),
        onOpenChange: () => {},
        onSave: async () => {},
      }),
    );
  });
  // Radix renders the dialog in a portal under document.body, not `container`.
  assert.match(window.document.body.textContent, /No server connections yet/);
  assert.equal(buttonWith("Save").disabled, true);
  await act(async () => buttonWith("Open Server connections").click());
  assert.equal(manage.length, 1);
  await act(async () => root.unmount());
});
