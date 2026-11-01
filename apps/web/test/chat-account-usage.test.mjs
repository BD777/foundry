import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
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
await import("../src/i18n/index.ts");
const { ChatAccountUsage } =
  await import("../src/features/chat/chat-account-usage.tsx");
const { accountUsageTarget } =
  await import("../src/features/chat/chat-account-usage-model.ts");
const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const device = { id: "dev", owned: true, status: "connected" };
const profile = {
  id: "official",
  deviceId: "dev",
  origin: "device",
  runtime: "codex",
  connectionType: "local_login",
  runtimeGeneration: "identity-a",
};
const target = accountUsageTarget(profile, [device]);
const result = (generation = "identity-a", rest = {}) => ({
  runtime: "codex",
  source: "/synthetic",
  sources: ["/synthetic"],
  executionSource: "/synthetic",
  status: "verified",
  checkedAt: new Date().toISOString(),
  runtimeGeneration: generation,
  authMode: "subscription",
  quotaStatus: "supported",
  message: "Synthetic",
  usage: [
    {
      id: "five_hour",
      windowMinutes: 300,
      usedPercent: 10,
      resetsAt: 1900000000,
    },
    { id: "seven_day", windowMinutes: 10080, usedPercent: 80 },
    { id: "model", label: "Model", windowMinutes: 10080 },
  ],
  ...rest,
});
const json = (x) =>
  new Response(JSON.stringify(x), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
test("only owned selected native profiles are eligible, never endpoint/name inference", () => {
  assert.ok(target);
  for (const patch of [
    { connectionType: "api_key" },
    { baseUrl: "https://gateway.test" },
    { origin: "server" },
    { runtimeGeneration: "" },
  ])
    assert.equal(
      accountUsageTarget({ ...profile, ...patch }, [device]),
      undefined,
    );
  assert.equal(
    accountUsageTarget(profile, [{ ...device, owned: false }]),
    undefined,
  );
  assert.equal(
    accountUsageTarget(
      { ...profile, label: "Codex Local", connectionType: "custom_command" },
      [device],
    ),
    undefined,
  );
});
test("right panel scopes asynchronous responses, deduplicates refresh and marks errors/offline", async () => {
  let resolveA,
    resolveB,
    calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Promise((r) => {
      if (body.runtimeGeneration === "identity-a") resolveA = r;
      else resolveB = r;
    });
  };
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(createElement(ChatAccountUsage, { target })),
  );
  assert.equal(calls.length, 1);
  const next = { ...target, generation: "identity-b" };
  await act(async () =>
    root.render(createElement(ChatAccountUsage, { target: next })),
  );
  await act(async () =>
    resolveB(
      json(
        result("identity-b", {
          usage: [{ id: "day", usedPercent: 22, windowMinutes: 1440 }],
        }),
      ),
    ),
  );
  await act(async () => resolveA(json(result())));
  await tick();
  assert.match(el.textContent, /22/);
  assert.doesNotMatch(el.textContent, /80/);
  const refresh = el.querySelector("button");
  await act(async () => {
    refresh.click();
    refresh.click();
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).refresh, true);
  await act(async () => resolveB(new Response("{}", { status: 503 })));
  await tick();
  assert.match(el.textContent, /Could not refresh/);
  assert.match(el.textContent, /22/);
  await act(async () =>
    root.render(
      createElement(ChatAccountUsage, { target: { ...next, online: false } }),
    ),
  );
  assert.match(el.textContent, /offline/i);
  assert.equal(el.querySelector("button").disabled, true);
  await act(async () => root.unmount());
  el.remove();
});
test("API-key inspection is hidden and multiple subscription windows expand with unknown preserved", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  globalThis.fetch = async () =>
    json(result("identity-a", { authMode: "api_key" }));
  await act(async () =>
    root.render(createElement(ChatAccountUsage, { target })),
  );
  await tick();
  assert.equal(el.textContent, "");
  globalThis.fetch = async () => json(result("identity-b"));
  await act(async () =>
    root.render(
      createElement(ChatAccountUsage, {
        target: { ...target, generation: "identity-b" },
      }),
    ),
  );
  await tick();
  assert.equal(el.querySelectorAll("progress").length, 2);
  const more = [...el.querySelectorAll("button")].find((x) =>
    x.textContent.includes("Show"),
  );
  await act(async () => more.click());
  assert.match(el.textContent, /Unknown/);
  assert.equal(el.querySelectorAll("progress").length, 2);
  await act(async () => root.unmount());
  el.remove();
});

test("a server account-change or permission conflict discards cached quota", async () => {
  for (const status of [401, 403, 404, 409]) {
    let calls = 0;
    globalThis.fetch = async () =>
      ++calls === 1 ? json(result()) : new Response("{}", { status });
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () =>
      root.render(createElement(ChatAccountUsage, { target })),
    );
    await tick();
    assert.match(el.textContent, /80/);
    await act(async () => el.querySelector("button").click());
    await tick();
    assert.equal(
      el.textContent,
      "",
      `status ${status} must discard the prior account's observation`,
    );
    await act(async () => root.unmount());
    el.remove();
  }
});
