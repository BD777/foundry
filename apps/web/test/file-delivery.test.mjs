import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);

const nativeFetch = globalThis.fetch;

async function dom(fetch, run) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
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
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ window, container, root, i18n });
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of previous)
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}
const wait = (ms = 1100) =>
  act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const item = {
  kind: "session-file",
  id: "file",
  label: "report.json",
  path: "/repo/.foundry/attachments/report.json",
  origin: "reference",
  op: "referenced",
  inGitRepo: false,
  turnIds: [],
  sessionId: "session",
  workspaceId: "workspace",
};
const file = {
  sessionId: "session",
  path: item.path,
  origin: "reference",
  insideWorkspace: true,
  kind: "text",
  content: '{"ok":true}',
  truncated: false,
  changedSinceRecorded: false,
};

test("session preview retries once, shows a short reason, and manual retry recovers", async () => {
  let calls = 0;
  let detail;
  await dom(
    () =>
      Promise.resolve(
        ++calls <= 2
          ? new Response("timeout", { status: 504 })
          : Response.json(file),
      ),
    async ({ root, container }) => {
      const { useChatContextDetail } =
        await import("../src/features/chat/use-chat-context-detail.ts");
      const { ChatDetailPanel } =
        await import("../src/features/chat/chat-detail-panel.tsx");
      function Harness() {
        detail = useChatContextDetail("thread");
        useEffect(() => detail.setSelection(item), []);
        return detail.selection
          ? createElement(ChatDetailPanel, {
              ...detail,
              onClose: detail.close,
              onRetry: detail.retry,
            })
          : null;
      }
      await act(async () => root.render(createElement(Harness)));
      assert.match(container.textContent, /Retrying once/);
      await wait();
      assert.equal(calls, 2);
      assert.match(container.textContent, /took too long/);
      assert.doesNotMatch(container.textContent, /within 15 seconds/);
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((b) => b.textContent === "Retry file")
          .click(),
      );
      await wait(30);
      assert.equal(calls, 3);
      assert.match(container.textContent, /"ok":true/);
      assert.match(container.textContent, /Download file/);
    },
  );
});

test("changing selection aborts a retry and cannot display the previous file", async () => {
  let calls = 0;
  let detail;
  await dom(
    () => {
      calls++;
      return Promise.resolve(new Response("offline", { status: 409 }));
    },
    async ({ root }) => {
      const { useChatContextDetail } =
        await import("../src/features/chat/use-chat-context-detail.ts");
      function Harness() {
        detail = useChatContextDetail("thread");
        return null;
      }
      await act(async () => root.render(createElement(Harness)));
      await act(async () => detail.setSelection(item));
      await act(async () => detail.close());
      await wait();
      assert.equal(calls, 1);
      assert.equal(detail.file, undefined);
      assert.equal(detail.selection, undefined);
    },
  );
});

test("workspace browser preview has the same retry and recovery path", async () => {
  let calls = 0;
  await dom(
    (url) =>
      Promise.resolve(
        String(url).includes("/tree?")
          ? Response.json([
              {
                id: "file",
                path: "report.json",
                name: "report.json",
                isDirectory: false,
              },
            ])
          : ++calls <= 2
            ? new Response("slow", { status: 504 })
            : Response.json({
                workspaceId: "workspace",
                path: "report.json",
                content: "workspace file",
                truncated: false,
              }),
      ),
    async ({ root, container }) => {
      const { ChatDetailPanel } =
        await import("../src/features/chat/chat-detail-panel.tsx");
      await act(async () =>
        root.render(
          createElement(ChatDetailPanel, {
            selection: {
              kind: "source",
              id: "source",
              label: "Folder",
              target: "/repo",
              workspaceId: "workspace",
            },
            loading: false,
            onClose: () => {},
          }),
        ),
      );
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((b) => b.title === "report.json")
          .click(),
      );
      await wait();
      assert.equal(calls, 2);
      assert.match(container.textContent, /took too long/);
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((b) => b.textContent === "Retry file")
          .click(),
      );
      await wait(30);
      assert.equal(calls, 3);
      assert.match(container.textContent, /workspace file/);
      assert.match(container.textContent, /Download file/);
    },
  );
});

test("download waits for complete raw bytes, retries an interrupted body, and offers recovery", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 1, 2, 3]);
  let calls = 0;
  const downloads = [];
  await dom(
    () =>
      Promise.resolve(
        ++calls === 1
          ? {
              ok: true,
              blob: () => Promise.reject(new TypeError("short body")),
            }
          : new Response(bytes),
      ),
    async ({ root, container, window }) => {
      const { ChatFileDownload } =
        await import("../src/features/chat/chat-file-download.tsx");
      const click = window.HTMLAnchorElement.prototype.click;
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ url: this.href, name: this.download });
      };
      try {
        await act(async () =>
          root.render(
            createElement(ChatFileDownload, {
              sessionId: "session",
              path: "/repo/full.bin",
            }),
          ),
        );
        await act(async () => container.querySelector("button").click());
        assert.ok(container.querySelector("button").disabled);
        assert.equal(downloads.length, 0);
        await wait();
        await wait(30);
        assert.equal(calls, 2);
        assert.equal(downloads.length, 1);
        assert.equal(downloads[0].name, "full.bin");
        assert.deepEqual(
          new Uint8Array(
            await (await nativeFetch(downloads[0].url)).arrayBuffer(),
          ),
          bytes,
        );
      } finally {
        window.HTMLAnchorElement.prototype.click = click;
      }
    },
  );
});

test("permanent download failures stay visible, with translated reasons and a working retry", async () => {
  let calls = 0;
  let downloads = 0;
  await dom(
    () =>
      Promise.resolve(
        ++calls <= 2
          ? new Response("slow", { status: 504 })
          : new Response("complete"),
      ),
    async ({ root, container, window, i18n }) => {
      const { ChatFileDownload } =
        await import("../src/features/chat/chat-file-download.tsx");
      const original = window.HTMLAnchorElement.prototype.click;
      window.HTMLAnchorElement.prototype.click = () => downloads++;
      try {
        await act(async () =>
          root.render(
            createElement(ChatFileDownload, {
              workspaceId: "workspace",
              path: "/repo/file.json",
            }),
          ),
        );
        await act(async () => container.querySelector("button").click());
        await wait();
        assert.equal(calls, 2);
        assert.match(container.textContent, /took too long/);
        assert.equal(downloads, 0);
        await act(async () => i18n.changeLanguage("zh-CN"));
        assert.match(container.textContent, /设备发送文件超时/);
        await act(async () =>
          Array.from(container.querySelectorAll("button"))
            .find((b) => b.textContent === "重试文件")
            .click(),
        );
        await wait(30);
        assert.equal(downloads, 1);
      } finally {
        window.HTMLAnchorElement.prototype.click = original;
      }
    },
  );
});
