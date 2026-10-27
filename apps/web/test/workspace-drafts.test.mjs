import { createFeedbackRoot } from "./feedback-root.mjs";
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

const { WorkspaceDrafts } =
  await import("../src/features/skills/workspace-drafts.tsx");

test("draft refresh and trial use an exact digest, while refresh failures remain visible", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = await createFeedbackRoot(container);
  const oldFetch = globalThis.fetch;
  let fail = false;
  const writes = [];
  const skill = {
    id: "draft",
    workspaceId: "w",
    executionRootId: "w",
    name: "example",
    relativePath: ".agents/skills/example",
    description: "Test method",
    digest: "abc123",
    status: "ready",
    snapshotPath: "/snapshot/SKILL.md",
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/agents?"))
      return new Response("[]", { status: 200 });
    const method = init?.method ?? "GET";
    if (method !== "GET")
      writes.push({ url: String(url), body: JSON.parse(init.body) });
    if (fail && String(url).endsWith("/refresh"))
      return new Response(JSON.stringify({ error: "worker offline" }), {
        status: 409,
      });
    return new Response(
      JSON.stringify({ enabled: true, supported: true, skills: [skill] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceDrafts, { workspaceId: "w", readOnly: false }),
      ),
    );
    assert.match(container.textContent, /example/);
    const refresh = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Refresh drafts",
    );
    await act(async () => refresh.click());
    assert.equal(writes[0].url.endsWith("/draft-skills/refresh"), true);
    fail = true;
    await act(async () => refresh.click());
    assert.match(
      container.querySelector('.fdy-toast[data-tone="error"]').textContent,
      /worker offline/,
    );
    assert.match(container.textContent, /example/);
    const trial = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Trial…",
    );
    await act(async () => trial.click());
    assert.match(document.body.textContent, /clean conversation/);
    assert.ok(document.querySelector("textarea"));
    assert.equal(
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Start trial",
      ).disabled,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = oldFetch;
  }
});
