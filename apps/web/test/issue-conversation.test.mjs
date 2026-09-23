import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
register("./bundler-resolve.mjs", import.meta.url);

test("Issue follow-up preserves history, submits feedback with current Run and displays errors", async () => {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
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
    "HTMLDivElement",
    "ResizeObserver",
    "MutationObserver",
    "Event",
    "MouseEvent",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const originalFetch = globalThis.fetch;
  const requests = [];
  let fail = false;
  let refreshed = "";
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return fail
      ? new Response("Workspace device is offline", { status: 503 })
      : Response.json({ id: "iss_feedback", status: "pending" });
  };
  const { IssueConversation } =
    await import("../src/features/issue-detail/issue-conversation.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const issue = {
    id: "iss_feedback",
    runtime: "claude",
    sourceInput: "Original goal",
    status: "verifying",
    run: { id: "run_latest" },
    messages: [{ id: "msg1", role: "assistant", text: "Original result" }],
  };
  try {
    await act(() =>
      root.render(
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 800, itemHeight: 100 } },
          createElement(IssueConversation, {
            issue,
            inputRef: null,
            onRefresh: (id) => {
              refreshed = id;
            },
          }),
        ),
      ),
    );
    assert.ok(container.querySelector('[aria-label="Issue follow-up"]'));
    const textarea = container.querySelector("textarea");
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, "Fix the knowledge document");
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(() =>
      container.querySelector('[aria-label="Send issue message"]').click(),
    );
    assert.equal(requests[0].expectedRunId, "run_latest");
    assert.equal(requests[0].message, "Fix the knowledge document");
    assert.equal(refreshed, "iss_feedback");
    // Project the newly completed execution before submitting another message.
    await act(() =>
      root.render(
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 800, itemHeight: 100 } },
          createElement(IssueConversation, {
            issue: { ...issue, run: { id: "run_next", status: "completed" } },
            inputRef: null,
            onRefresh() {},
          }),
        ),
      ),
    );
    fail = true;
    await act(() => {
      textarea.value = "Try again";
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(() =>
      container.querySelector('[aria-label="Send issue message"]').click(),
    );
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Workspace device is offline/,
    );

    const { applyFoundryStreamEvent } =
      await import("../src/app/foundry-data-projection.ts");
    const { issueTranscript } =
      await import("../src/features/issue-detail/issue-transcript.ts");
    const { ChatMessageRow } =
      await import("../src/components/conversation/chat-message-list.tsx");
    let liveData = {
      workspace: { id: "w" },
      runs: [],
      issues: [
        {
          id: "live",
          runtime: "claude",
          status: "in_progress",
          sourceInput: "hi",
          messages: [
            {
              id: "continue",
              role: "user",
              text: "继续",
              createdAt: "2026-09-09T07:32:34Z",
            },
          ],
          run: {
            id: "r",
            issueId: "live",
            status: "running",
            startedAt: "2026-09-09T07:32:34.306Z",
            events: [],
          },
        },
      ],
    };
    const renderLive = () =>
      act(() =>
        root.render(
          createElement(
            "div",
            null,
            ...issueTranscript(liveData.issues[0]).map((message) =>
              createElement(ChatMessageRow, { key: message.id, message }),
            ),
          ),
        ),
      );
    for (const [id, label, detail, expected] of [
      ["one", "Response reset", "正在", "正在"],
      ["two", "Response delta", "输出", "正在输出"],
    ]) {
      liveData = applyFoundryStreamEvent(liveData, {
        type: "issue_run_event",
        payload: { id, runId: "r", label, detail },
      });
      await renderLive();
      const rows = [...container.querySelectorAll("[data-role]")];
      assert.deepEqual(
        rows.map((row) => row.getAttribute("data-role")),
        ["user", "user", "bot"],
      );
      assert.match(rows[1].textContent, /继续/);
      assert.ok(rows[2].textContent.includes(expected));
      assert.equal(rows[2].getAttribute("data-streaming"), "true");
    }
  } finally {
    await act(() => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
