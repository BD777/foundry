import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
  });
test.after(() => window.happyDOM.close());
const { SteerStatus, steerStopOfferMs } =
  await import("../src/components/conversation/steer-status.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");

function mount(props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(SteerStatus, props)));
  return {
    host,
    rerender: (next) =>
      act(() => root.render(createElement(SteerStatus, next))),
    unmount: () => act(() => root.unmount()),
  };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const button = (host, text) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent.includes(text),
  );

test("waiting: says what the message waits behind and for how long", () => {
  const view = mount({
    steer: {
      runtime: "claude",
      state: "waiting",
      deliveredAt: ago(10_000),
      tool: { name: "Bash", startedAt: ago(163_000), limitMs: 240_000 },
    },
    onStop: async () => {},
  });
  const text = view.host.textContent;
  assert.match(
    text,
    /Delivered · Claude reads it after Bash finishes \(running 2m 4[23]s \/ up to 4m 0s\)/,
  );
  // Not offered before the message has waited a minute.
  assert.equal(button(view.host, "Stop Bash"), undefined);
  view.unmount();
});

test("after a minute: one explicit stop, confirmed, that says the command stops", async () => {
  const stops = [];
  const view = mount({
    steer: {
      runtime: "claude",
      state: "waiting",
      deliveredAt: ago(steerStopOfferMs + 1_000),
      tool: { name: "Bash", startedAt: ago(200_000) },
    },
    onStop: async () => void stops.push("stop"),
  });
  const offer = button(view.host, "Stop Bash and read now");
  assert.ok(offer);
  act(() => offer.click());
  assert.equal(stops.length, 0, "the first click only asks");
  assert.match(view.host.textContent, /The running command is stopped/);
  // The safe choice has focus.
  assert.equal(document.activeElement?.textContent, "Keep waiting");
  await act(async () => button(view.host, "Stop Bash").click());
  assert.deepEqual(stops, ["stop"]);
  assert.match(view.host.textContent, /Stopping Bash…/);
  view.rerender({
    steer: {
      runtime: "claude",
      state: "read",
      deliveredAt: ago(70_000),
      readAt: "2026-10-29T14:00:16Z",
    },
  });
  assert.match(view.host.textContent, /Claude read it at/);
  view.unmount();
});

test("a failed stop says so and offers it again", async () => {
  const view = mount({
    steer: {
      runtime: "claude",
      state: "waiting",
      deliveredAt: ago(90_000),
      tool: { name: "Bash", startedAt: ago(100_000) },
    },
    onStop: async () => {
      throw new Error("This background task is not running.");
    },
  });
  act(() => button(view.host, "Stop Bash and read now").click());
  await act(async () => {
    button(view.host, "Stop Bash").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The failure goes to a toast (checked in the browser); the stop stays
  // offered and the row does not claim it is stopping.
  assert.doesNotMatch(view.host.textContent, /Stopping/);
  assert.ok(button(view.host, "Stop Bash"));
  view.unmount();
});

test("Codex: its own wording, and no stop", () => {
  const view = mount({
    steer: {
      runtime: "codex",
      state: "waiting",
      deliveredAt: ago(120_000),
      tool: { name: "the command", startedAt: ago(130_000) },
    },
  });
  assert.match(
    view.host.textContent,
    /Codex reads it when the command returns/,
  );
  assert.equal(view.host.querySelector("button"), null);
  view.unmount();
});
