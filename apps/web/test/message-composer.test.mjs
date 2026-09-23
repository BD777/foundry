import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

test("shared composer protects IME input and portaled selection works outside clipping parents", async () => {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
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
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { ComposerInput } =
    await import("../src/components/ui/message-composer.tsx");
  const { createRoot } = await import("react-dom/client");
  const { SelectMenu } = await import("../src/components/ui/select-menu.tsx");
  const container = window.document.createElement("div");
  container.style.overflow = "hidden";
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    let submissions = 0;
    const inputProps = {
      value: "中文草稿",
      onChange() {},
      onSubmit() {
        submissions++;
      },
    };
    await act(() => root.render(createElement(ComposerInput, inputProps)));
    const press = (options) =>
      act(() =>
        container.querySelector("textarea").dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        ),
      );
    await press({ isComposing: true });
    await press({ keyCode: 229 });
    await press({ shiftKey: true });
    assert.equal(
      submissions,
      0,
      "IME confirmation and Shift+Enter preserve the draft",
    );
    await press({});
    assert.equal(submissions, 1);
    await act(() =>
      root.render(
        createElement(ComposerInput, { ...inputProps, submitDisabled: true }),
      ),
    );
    await press({});
    assert.equal(
      submissions,
      1,
      "unavailable or pending submission cannot be triggered by Enter",
    );

    let selected;
    await act(() =>
      root.render(
        createElement(SelectMenu, {
          ariaLabel: "Agent",
          value: "claude",
          onChange(value) {
            selected = value;
          },
          options: [
            { label: "Claude", value: "claude" },
            { label: "Codex", value: "codex" },
            { label: "Unavailable", value: "missing", disabled: true },
          ],
        }),
      ),
    );
    await act(() =>
      container.querySelector("button").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      container.querySelector("[role=menu]"),
      null,
      "popover escapes the clipping container",
    );
    const menu = window.document.querySelector("[role=menu]");
    assert.ok(menu);
    const options = [...menu.querySelectorAll("[role=menuitemradio]")];
    assert.equal(options.length, 3);
    assert.equal(options[0].getAttribute("aria-checked"), "true");
    assert.equal(options[2].getAttribute("aria-disabled"), "true");
    await act(() => options[2].click());
    assert.equal(selected, undefined);
    await act(() => options[1].click());
    assert.equal(selected, "codex");
    assert.equal(window.document.querySelector("[role=menu]"), null);

    const { AgentComposer } =
      await import("../src/components/ui/agent-composer.tsx");
    const noop = () => {};
    const controls = {
      selectedRuntime: "claude",
      modelValue: "model-a",
      modelOptions: [{ id: "model-a", label: "Model A" }],
      modelLoading: false,
      modelLoadFailed: false,
      claudeEffort: "max",
      codexReasoningEffort: "high",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
      codexSpeed: "standard",
      onModelChange: noop,
      onClaudeEffortChange: noop,
      onCodexReasoningEffortChange: noop,
      onClaudePermissionModeChange: noop,
      onCodexApprovalPolicyChange: noop,
      onCodexSandboxModeChange: noop,
      onCodexSpeedChange: noop,
      onResetControls: noop,
    };
    const composer = {
      input: inputProps,
      agentOptions: [
        { value: "profile", label: "My Claude", runtime: "claude" },
      ],
      agentValue: "profile",
      onAgentChange: noop,
      runtimeControls: controls,
      fileInput: {},
      onAttach: noop,
      onAction: noop,
      actionLabel: "Send",
    };
    await act(() =>
      root.render(
        createElement(AgentComposer, { ...composer, showPermissions: false }),
      ),
    );
    assert.ok(container.querySelector(".fdy-message-composer textarea"));
    assert.equal(container.querySelector('[aria-label^="Permissions"]'), null);
    assert.ok(
      container.querySelector('[aria-label^="Model and effort"]'),
      "hiding permissions keeps the same model/effort control",
    );
    await act(() =>
      container.querySelector('[aria-label^="Model and effort"]').dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.match(
      window.document.querySelector('[role="menu"]').textContent,
      /推理强度/,
    );
    await act(() =>
      root.render(
        createElement(AgentComposer, { ...composer, showPermissions: true }),
      ),
    );
    assert.ok(
      container.querySelector('[aria-label^="Permissions"]'),
      "Chats restores only the permission entry through the flag",
    );
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
