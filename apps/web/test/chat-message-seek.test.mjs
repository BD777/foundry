import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const { createTranscriptLoader } =
  await import("../src/features/chat/thread/chat-transcript-loader.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const page = (id, eventsBefore, events = []) => ({
  id,
  workspaceId: "ws_seek",
  provider: "codex",
  status: "completed",
  prompt: "",
  events,
  ...(eventsBefore ? { eventsBefore } : {}),
});

test("a seek reads back to a message in one read per session, skips sessions without it, and names one no session holds", async () => {
  const through = [];
  const loaded = [];
  let state;
  const loader = createTranscriptLoader({
    transport: {
      loadRecent: async () => [page("sess_a", "a100"), page("sess_b", "b50")],
      loadEarlier: async () => assert.fail("a seek reads through, not by page"),
      loadThrough: async (sessionId, before, messageId) => {
        through.push([sessionId, before, messageId]);
        if (sessionId === "sess_a" || before === "b10") return undefined;
        return page("sess_b", "b10", [{ id: "evt_old", sessionId }]);
      },
    },
    onState: (next) => (state = next),
    onLoaded: (sessions) => loaded.push(...sessions.map((s) => s.id)),
  });
  loader.select("thread");
  // Before the chat's first load there is nothing to read back from.
  loader.seekMessage("msg_old");
  assert.deepEqual(through, []);
  loader.request("missing");
  await tick();
  loaded.length = 0;

  loader.seekMessage("msg_old");
  await tick();
  assert.deepEqual(through, [
    ["sess_a", "a100", "msg_old"],
    ["sess_b", "b50", "msg_old"],
  ]);
  assert.deepEqual(loaded, ["sess_b"]);
  assert.deepEqual(state.earlier, { sess_a: "a100", sess_b: "b10" });
  assert.equal(state.loadingEarlier, false);
  assert.equal(state.missingMessage, undefined);

  // The page held no row of it (the caller asks again): a session without
  // it is not asked again, and with none left the message is missing.
  loader.seekMessage("msg_old");
  await tick();
  assert.deepEqual(through.slice(2), [["sess_b", "b10", "msg_old"]]);
  assert.equal(state.missingMessage, "msg_old");
  // Paging back stays as it was for the person.
  assert.deepEqual(state.earlier, { sess_a: "a100", sess_b: "b10" });
  loader.dispose();
});

test("a seek after a failed read waits for the person's retry instead of asking in a loop", async () => {
  let reads = 0;
  let state;
  const loader = createTranscriptLoader({
    transport: {
      loadRecent: async () => [page("sess_a", "a100")],
      loadEarlier: async () => page("sess_a", "a50"),
      loadThrough: async () => {
        reads += 1;
        throw new Error("offline");
      },
    },
    onState: (next) => (state = next),
    onLoaded: () => {},
  });
  loader.select("thread");
  loader.request("missing");
  await tick();
  loader.seekMessage("msg_old");
  await tick();
  assert.equal(state.earlierFailed, true);
  loader.seekMessage("msg_old");
  await tick();
  assert.equal(reads, 1);
  assert.equal(state.missingMessage, undefined);
  // The history row's retry reads a page; the seek then goes on.
  loader.loadEarlier();
  await tick();
  assert.equal(state.earlierFailed, false);
  loader.seekMessage("msg_old");
  await tick();
  assert.equal(reads, 2);
  loader.dispose();
});

test("without a read-through transport a seek pages back until the history ends", async () => {
  const pages = [];
  let state;
  const loader = createTranscriptLoader({
    transport: {
      loadRecent: async () => [page("sess_a", "2")],
      loadEarlier: async (sessionId, before) => {
        pages.push(before);
        return page(sessionId, before === "2" ? "1" : undefined);
      },
    },
    onState: (next) => (state = next),
    onLoaded: () => {},
  });
  loader.select("thread");
  loader.request("missing");
  await tick();
  for (let index = 0; index < 3; index++) {
    loader.seekMessage("msg_gone");
    await tick();
  }
  assert.deepEqual(pages, ["2", "1"]);
  assert.deepEqual(state.earlier, {});
  assert.equal(state.missingMessage, "msg_gone");
  loader.dispose();
});

function setupDom(t, url) {
  const window = new Window({ url });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    fetch: async () =>
      new Response(JSON.stringify({ revision: 1, groups: [], positions: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    EventSource: class {
      addEventListener() {}
      close() {}
    },
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ResizeObserver",
    "IntersectionObserver",
    "CustomEvent",
    "Event",
    "PopStateEvent",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "NodeFilter",
    "DOMRect",
    "Range",
  ])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  });
  return { window, root };
}

test("a chat opened at a message it has not loaded reads back to it, and says so once the chat no longer holds it", async (t) => {
  const { window, root } = setupDom(
    t,
    "http://foundry.test/chats/sess_seek?message=msg_old",
  );
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const { ChatSurface } = await import("../src/features/chat/chat-surface.tsx");
  const { archiveSurfaceProps } =
    await import("./fixtures/chat-archive-surface-props.ts");
  const { ToastProvider } = await import("../src/components/ui/toast.tsx");
  const sought = [];
  let missing = 0;
  const render = (overrides) =>
    act(() =>
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(
            ChatSurface,
            archiveSurfaceProps({
              threadKey: "ws_seek:sess_seek",
              onSeekMessage: (id) => sought.push(id),
              onMessageMissing: () => (missing += 1),
              ...overrides,
            }),
          ),
        ),
      ),
    );
  const message = (id) => ({
    id: `agent-session:sess_seek:${id}`,
    role: "assistant",
    text: id,
  });
  await render({ messages: [message("msg_new")] });
  assert.deepEqual(sought, ["msg_old"]);
  // Loaded: the transcript scrolls to it; nothing more is read.
  await render({ messages: [message("msg_old"), message("msg_new")] });
  assert.deepEqual(sought, ["msg_old"]);

  // Another link, to one the chat no longer holds.
  window.history.pushState(null, "", "/chats/sess_seek?message=msg_gone");
  await act(async () =>
    window.dispatchEvent(new window.PopStateEvent("popstate")),
  );
  await render({ messages: [message("msg_new")] });
  assert.equal(sought.at(-1), "msg_gone");
  await render({
    messages: [message("msg_new")],
    missingMessageId: "msg_gone",
  });
  assert.equal(missing, 1);
  assert.equal(new URL(window.location.href).searchParams.get("message"), null);
  await render({
    messages: [message("msg_new")],
    missingMessageId: "msg_gone",
  });
  assert.equal(missing, 1, "the notice is said once");
});
