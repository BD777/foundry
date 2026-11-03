import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
register("./bundler-resolve.mjs", import.meta.url);

/**
 * A page with the Issue conversation; `serve` answers its requests, each
 * recorded as { method, path, body }.
 */
async function withConversation(serve, run) {
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
    // The conversation follows its executions' events.
    EventSource: class {
      addEventListener() {}
      close() {}
    },
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
  // Imported once the page exists, as in the browser.
  const { IssueConversation } =
    await import("../src/features/issue-detail/issue-conversation.tsx");
  const { sessionTranscriptItems } =
    await import("../src/features/chat/thread/chat-message-items.ts");
  const executionTranscript = (sessions) => sessionTranscriptItems(sessions);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = {
      method: options.method ?? "GET",
      path: new URL(String(url), "http://foundry.test").pathname,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    requests.push(request);
    return serve(request);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (issue) =>
    act(() =>
      root.render(
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 800, itemHeight: 100 } },
          createElement(IssueConversation, {
            issue,
            inputRef: null,
            executionTranscript,
          }),
        ),
      ),
    );
  const type = (text) =>
    act(() => {
      const textarea = container.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, text);
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  const click = (selector) =>
    act(() => container.querySelector(selector).click());
  try {
    await run({ container, requests, render, type, click, root });
  } finally {
    await act(() => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
}

test("Issue follow-up preserves history, submits feedback with current Run and displays errors", async () => {
  let fail = false;
  await withConversation(
    ({ path }) =>
      path.endsWith("/executions")
        ? Response.json([])
        : fail
          ? new Response("Workspace device is offline", { status: 503 })
          : Response.json({ id: "iss_feedback", status: "pending" }),
    async ({ container, requests, render, type, click }) => {
      const issue = {
        id: "iss_feedback",
        runtime: "claude",
        sourceInput: "Original goal",
        status: "verifying",
        run: { id: "run_latest" },
        messages: [{ id: "msg1", role: "assistant", text: "Original result" }],
      };
      await render(issue);
      assert.ok(container.querySelector('[aria-label="Issue follow-up"]'));
      await type("Fix the knowledge document");
      await click('[aria-label="Send issue message"]');
      const sent = requests.filter((request) => request.method === "POST");
      assert.equal(sent[0].body.expectedRunId, "run_latest");
      assert.equal(sent[0].body.text, "Fix the knowledge document");
      assert.equal(
        sent.length,
        1,
        "no read follows: the server announces the changed Issue",
      );
      // Project the newly completed execution before submitting another message.
      await render({ ...issue, run: { id: "run_next", status: "completed" } });
      fail = true;
      await type("Try again");
      await click('[aria-label="Send issue message"]');
      assert.match(
        container.querySelector('[role="alert"]').textContent,
        /Workspace device is offline/,
      );
    },
  );
});

/** A running execution of the Issue, as GET /api/issues/{id}/executions reads it. */
const runningExecution = (id, provider) => ({
  id,
  issueId: "iss_live",
  role: "issue_execution",
  provider,
  status: "running",
  startedAt: "2026-09-09T07:32:34.306Z",
  input: { id: "input", prompt: "Implement ISS-7" },
  events: [
    {
      id: "evt_input",
      sessionId: id,
      at: "2026-09-09T07:32:34.306Z",
      label: "User message",
      level: "info",
      detail: "Implement ISS-7",
      message: { id: "input", kind: "user", text: "Implement ISS-7" },
    },
    {
      id: "evt_answer",
      sessionId: id,
      at: "2026-09-09T07:32:35Z",
      label: "Response stream",
      level: "info",
      detail: "Working on the layout",
    },
  ],
});

for (const runtime of ["claude", "codex"]) {
  test(`a ${runtime} Issue execution is read in one request, steered and stopped as its session`, async () => {
    const execution = runningExecution(`sess_${runtime}`, runtime);
    await withConversation(
      ({ path }) =>
        path === "/api/issues/iss_live/executions"
          ? Response.json([execution])
          : Response.json({ ...execution, events: undefined }),
      async ({ container, requests, render, type, click }) => {
        const issue = {
          id: "iss_live",
          workspaceId: "ws",
          runtime,
          sourceInput: "Build the page",
          status: "in_progress",
          run: { id: execution.id, status: "running" },
          messages: [],
        };
        await render(issue);
        await act(() => new Promise((done) => setTimeout(done, 20)));
        assert.deepEqual(
          requests.map(({ method, path }) => `${method} ${path}`),
          ["GET /api/issues/iss_live/executions"],
          "the conversation reads its executions once, with their events",
        );
        // A message typed while it runs waits; Steer sends it into the turn.
        await type("Focus on mobile");
        await click('[aria-label="Send issue message"]');
        const steer = [...container.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === "Steer",
        );
        assert.ok(steer, "a running execution of either runtime takes steers");
        await act(() => steer.click());
        await act(async () => {});
        const steered = requests.find(
          (request) =>
            request.path === `/api/agent-sessions/${execution.id}/messages`,
        );
        assert.equal(steered?.method, "POST");
        assert.equal(steered.body.prompt, "Focus on mobile");
        assert.equal(
          requests.some((request) => request.path.includes("/environment")),
          false,
        );
        await type("");
        await click('[aria-label="Stop agent response"]');
        assert.ok(
          requests.some(
            (request) =>
              request.method === "POST" &&
              request.path === `/api/agent-sessions/${execution.id}/cancel`,
          ),
        );
        assert.equal(
          requests.filter((request) => request.method === "GET").length,
          1,
          "steering and stopping read nothing more",
        );
      },
    );
  });
}
