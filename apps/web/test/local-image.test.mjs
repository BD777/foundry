import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);

async function mounted(fetchImage, inspect) {
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    fetch: (url, init) =>
      String(url).includes("variant=placeholder")
        ? Promise.resolve(new Response("", { status: 404 }))
        : fetchImage(url, init),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { LocalImage } =
    await import("../src/components/conversation/local-image.tsx");
  const { i18n } = await import("../src/i18n/index.ts");
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let active = true;
  const unmount = async () => {
    if (active) {
      active = false;
      await act(async () => root.unmount());
    }
  };
  const render = async (
    path = "/ws/.foundry/attachments/shot.png",
    onPreview = () => {},
  ) => {
    await act(async () =>
      root.render(
        createElement(LocalImage, { path, alt: "Screenshot", onPreview }),
      ),
    );
  };
  try {
    await render();
    await inspect({ container, window, render, unmount, i18n });
  } finally {
    await unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
}
const wait = async (ms = 1100) =>
  act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const ok = () => new Response(new Blob(["image"], { type: "image/png" }));

test("loading has a status, successful image opens its accessible preview", async () => {
  let resolve;
  let previewed = 0;
  await mounted(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    async ({ container, window, render }) => {
      assert.match(container.textContent, /Loading image from device/);
      assert.equal(container.querySelector("img"), null);
      await act(async () => resolve(ok()));
      await render(undefined, () => {
        previewed++;
      });
      const img = container.querySelector("img");
      assert.ok(img.hidden, "decode failures cannot display a broken icon");
      await act(async () => img.dispatchEvent(new window.Event("load")));
      assert.equal(container.querySelector('[role="status"]'), null);
      assert.equal(img.hidden, false);
      await act(async () =>
        container
          .querySelector('button[aria-label="Preview Screenshot"]')
          .click(),
      );
      assert.equal(previewed, 1);
    },
  );
});

test("a timeout retries once, then a visible reason and manual retry recover", async () => {
  let calls = 0;
  await mounted(
    () =>
      Promise.resolve(
        ++calls <= 2 ? new Response("slow", { status: 504 }) : ok(),
      ),
    async ({ container, window }) => {
      assert.match(container.textContent, /Retrying once/);
      await wait();
      assert.equal(calls, 2);
      assert.match(container.textContent, /took too long/);
      assert.equal(container.querySelector("img"), null);
      await wait();
      assert.equal(calls, 2, "no retry loop");
      await act(async () => container.querySelector("button").click());
      assert.equal(calls, 3);
      await wait(50);
      await act(async () =>
        container.querySelector("img").dispatchEvent(new window.Event("load")),
      );
      assert.ok(
        container.querySelector('button[aria-label="Preview Screenshot"]'),
      );
    },
  );
});

test("offline is distinguished from missing; missing is not retried automatically and copy translates", async () => {
  let calls = 0;
  await mounted(
    () => {
      calls++;
      return Promise.resolve(new Response("missing", { status: 404 }));
    },
    async ({ container, i18n }) => {
      assert.match(container.textContent, /not found/);
      await act(async () => i18n.changeLanguage("zh-CN"));
      assert.match(container.textContent, /设备上未找到/);
      assert.match(container.querySelector("button").textContent, /重试图片/);
      await wait();
      assert.equal(calls, 1);
    },
  );
  await mounted(
    () => Promise.resolve(new Response("offline", { status: 409 })),
    async ({ container }) => {
      await wait();
      assert.match(container.textContent, /device is offline/);
    },
  );
});

test("a truncated body retries and unmount aborts pending work", async () => {
  let calls = 0;
  let signal;
  await mounted(
    (_url, init) => {
      signal = init.signal;
      calls++;
      return Promise.resolve(
        calls === 1
          ? { ok: true, blob: () => Promise.reject(new Error("short body")) }
          : ok(),
      );
    },
    async ({ container, window, unmount }) => {
      await wait();
      assert.equal(calls, 2);
      await act(async () =>
        container.querySelector("img").dispatchEvent(new window.Event("load")),
      );
      assert.ok(container.querySelector("img").src.startsWith("blob:"));
      await unmount();
      assert.equal(signal.aborted, true);
    },
  );
});

test("image reads allow private HTTP caching and keep a slow read alive until unmount", async () => {
  let resolve,
    signal,
    calls = 0;
  await mounted(
    (_, options) => {
      calls++;
      signal = options.signal;
      assert.equal(options.cache, "default");
      return new Promise((done) => {
        resolve = done;
      });
    },
    async ({ container, window }) => {
      await wait(1900);
      assert.equal(signal.aborted, false);
      assert.equal(calls, 1);
      await act(async () => resolve(ok()));
      const img = container.querySelector("img");
      await act(async () => img.dispatchEvent(new window.Event("load")));
      assert.equal(img.hidden, false);
    },
  );
  const modes = [];
  await mounted(
    (_, options) => {
      modes.push(options.cache);
      return Promise.resolve(new Response("missing", { status: 404 }));
    },
    async ({ container }) => {
      await wait(30);
      await act(async () => container.querySelector("button").click());
      await wait(30);
      assert.deepEqual(modes, ["default", "reload"]);
    },
  );
});
