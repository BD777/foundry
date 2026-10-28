import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const ws = "ws_8d046eba-109d-4017-b22f-6311250f90a7";
const dev = "dev_cd7e38ee-f3e8-44e7-9107-40df843469dd";

async function withWindow(url, run) {
  const window = new Window({ url });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IntersectionObserver: window.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "PopStateEvent",
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
  try {
    return await run(window);
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

async function renderMarkdown(text, inspect, url) {
  return withWindow(
    url ?? `https://foundry.test/chats/sess_1?workspace=${ws}`,
    async () => {
      const { MarkdownContent } =
        await import("../src/components/conversation/markdown-content.tsx");
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(createElement(MarkdownContent, {}, text)),
        );
        return await inspect(container);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
}

const links = (container) =>
  [...container.querySelectorAll("a")].map((a) => ({
    href: a.getAttribute("href"),
    id: a.getAttribute("data-foundry-id"),
    target: a.getAttribute("target"),
    text: a.textContent,
  }));

test("Foundry ids are found as whole words, CJK text touching them", async () => {
  const { findFoundryIds, foundryIdKind } =
    await import("../src/lib/foundry-ids.ts");
  const ids = (text) => findFoundryIds(text).map((match) => match.id);
  assert.deepEqual(ids("见sess_12，以及iss_3。"), ["sess_12", "iss_3"]);
  assert.deepEqual(ids(`在 ${ws} 的 ${dev} 上`), [ws, dev]);
  assert.deepEqual(ids("native_claude_4f2a-91 ok"), ["native_claude_4f2a-91"]);
  for (const text of [
    "foo_sess_12",
    "sess_12x",
    "a/sess_12",
    "x.sess_12",
    "me@sess_12",
    "ws_001",
    "dev_linux",
    "sess_",
  ])
    assert.deepEqual(ids(text), [], text);
  assert.equal(foundryIdKind("sess_7"), "session");
  assert.equal(foundryIdKind(ws), "workspace");
  assert.equal(foundryIdKind("sess_7 "), undefined);
});

test("ids in prose and alone in code spans link to their pages; code and links stay", async () => {
  const markdown = [
    "会话sess_12已完成，Issue iss_3 在 `" + ws + "`，设备 " + dev + "。",
    "",
    "`run sess_12` stays code; [label](https://example.com/sess_9) stays.",
    "",
    "```",
    "sess_44",
    "```",
  ].join("\n");
  await renderMarkdown(markdown, (container) => {
    assert.deepEqual(links(container), [
      { href: "/chats/sess_12", id: "sess_12", target: null, text: "sess_12" },
      { href: "/issues/iss_3", id: "iss_3", target: null, text: "iss_3" },
      { href: `/locations/${ws}`, id: ws, target: null, text: ws },
      { href: `/devices/${dev}/agents`, id: dev, target: null, text: dev },
      {
        href: "https://example.com/sess_9",
        id: null,
        target: "_blank",
        text: "label",
      },
    ]);
    // The workspace id keeps its code look inside the link.
    assert.ok(container.querySelector(`a[data-foundry-id="${ws}"] > code`));
    assert.match(container.querySelector("pre").textContent, /sess_44/);
    assert.equal(container.querySelector("pre a"), null);
  });
});

test("a native chat id stays text with a title", async () => {
  await renderMarkdown(
    "from native_codex_abc123 and `native_claude_x1`",
    (c) => {
      assert.equal(c.querySelectorAll("a").length, 0);
      const marked = c.querySelectorAll("[data-foundry-native-id]");
      assert.deepEqual(
        [...marked].map((node) => node.getAttribute("data-foundry-native-id")),
        ["native_codex_abc123", "native_claude_x1"],
      );
      assert.ok(marked[0].getAttribute("title"));
      assert.equal(marked[0].tagName, "SPAN");
    },
  );
});

test("an ordinary click opens the id's page in place; a modified one is the browser's", async () => {
  await renderMarkdown("open sess_12", async (container) => {
    const link = container.querySelector("a");
    const pops = [];
    window.addEventListener("popstate", () => pops.push(window.location.href));
    // What the app left to the browser; the test browser does not follow it.
    const leftToBrowser = [];
    document.addEventListener("click", (event) => {
      leftToBrowser.push(!event.defaultPrevented);
      event.preventDefault();
    });
    const modified = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    await act(async () => link.dispatchEvent(modified));
    assert.deepEqual(leftToBrowser, [true]);
    assert.deepEqual(pops, []);
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(plain));
    assert.deepEqual(leftToBrowser, [true, false]);
    // No workspace in the link: it opens where it is, and the chat page
    // moves it to the chat's own workspace (useFollowLinkedChat).
    assert.deepEqual(pops, [
      `https://foundry.test/chats/sess_12?workspace=${ws}`,
    ]);
  });
});

test("links to this app's pages open in place; other links in a new tab", async () => {
  const markdown = [
    `[same origin](https://foundry.test/chats/sess_5?workspace=${ws})`,
    "[root path](/issues/iss_8)",
    "[not a page](/home/u/notes.md)",
    "[api](https://foundry.test/api/health)",
    "[elsewhere](https://other.test/chats/sess_5)",
  ].join(" ");
  await renderMarkdown(markdown, (container) => {
    assert.deepEqual(
      links(container).map(({ href, target, text }) => ({
        href,
        target,
        text,
      })),
      [
        {
          href: `https://foundry.test/chats/sess_5?workspace=${ws}`,
          target: null,
          text: "same origin",
        },
        { href: "/issues/iss_8", target: null, text: "root path" },
        {
          href: "https://foundry.test/api/health",
          target: "_blank",
          text: "api",
        },
        {
          href: "https://other.test/chats/sess_5",
          target: "_blank",
          text: "elsewhere",
        },
      ],
    );
    const text = [...container.querySelectorAll("span[title]")].find(
      (span) => span.textContent === "not a page",
    );
    assert.equal(text?.getAttribute("title"), "/home/u/notes.md");
  });
});

test("app addresses keep the workspace a link names, else the one shown", async () => {
  await withWindow(`https://foundry.test/issues?workspace=${ws}`, async () => {
    const { appUrlFor } = await import("../src/app/navigation.ts");
    assert.equal(appUrlFor("/chats/sess_1"), `/chats/sess_1?workspace=${ws}`);
    assert.equal(
      appUrlFor("https://foundry.test/chats/sess_1?workspace=ws_b"),
      "/chats/sess_1?workspace=ws_b",
    );
    assert.equal(
      appUrlFor(`/devices/${dev}`),
      `/devices/${dev}/agents?workspace=${ws}`,
    );
    assert.equal(appUrlFor("/api/agent-sessions"), undefined);
    assert.equal(appUrlFor("https://other.test/chats/sess_1"), undefined);
    assert.equal(appUrlFor("mailto:a@b.c"), undefined);
  });
});

test("a chat followed into its workspace reads as opening until the switch ends", async () => {
  const { linkedChatNotice } =
    await import("../src/features/chat/chat-thread-notice.ts");
  const elsewhere = { state: "elsewhere", workspaceId: "ws_b" };
  const following = linkedChatNotice(elsewhere, "sess_1", [], () => {}, true);
  assert.equal(following?.action, undefined);
  assert.equal(
    following?.title,
    linkedChatNotice({ state: "loading" }, "sess_1", [], () => {}).title,
  );
  // A switch that failed offers it again.
  const failed = linkedChatNotice(elsewhere, "sess_1", [], () => {}, false);
  assert.ok(failed?.action);
});
