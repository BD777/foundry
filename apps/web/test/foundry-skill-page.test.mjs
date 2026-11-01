import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({ url: "http://127.0.0.1/workspace/skills/foundry" });
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
  "PopStateEvent",
  "FocusEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: window[key],
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

const { createRoot } = await import("react-dom/client");
await import("../src/i18n/index.ts");
const { FoundrySkillPage } =
  await import("../src/features/skills/foundry-skill-page.tsx");
const { OfficialSkillsSection } =
  await import("../src/features/skills/official-skills-section.tsx");

const detail = {
  name: "foundry",
  description: "Work with Foundry.",
  source: "Foundry",
  revisions: [
    { runtime: "claude", revision: 4 },
    { runtime: "codex", revision: 4 },
  ],
  tools: [
    {
      name: "create_session",
      summary: "Starts a new session with a task.",
      limits: [
        "At most 8 sessions it started queued, running or blocked at once.",
      ],
      readOnly: false,
      roles: ["session", "issue_execution"],
    },
    {
      name: "read_context",
      summary: "Reads a session in depth.",
      limits: ["Output is cut at maxBytes, 12000 by default."],
      readOnly: true,
      roles: ["session", "issue_execution", "issue_clarification", "verifier"],
    },
  ],
  guidance: [
    {
      heading: "Facts",
      points: [
        "`cancel_session` never stops the sessions the canceled one started.",
      ],
    },
  ],
  manifest: "---\nname: foundry\n---\n\n# Foundry\n",
};

async function render(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

test("the page lists each tool with its limits and roles, then the guidance, and opens SKILL.md", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify(detail), { status: 200 });
  };
  const view = await render(createElement(FoundrySkillPage));
  try {
    await settle();
    assert.ok(
      requests.some((url) => url.endsWith("/api/builtin-skills/foundry")),
    );
    const { container } = view;
    const tools = [
      ...container.querySelectorAll(".fdy-foundry-skill-tools > li"),
    ];
    assert.equal(tools.length, 2);
    assert.match(tools[0].textContent, /create_session/);
    assert.match(tools[0].textContent, /At most 8 sessions/);
    assert.match(tools[0].textContent, /Available toSessionsIssue execution$/);
    assert.doesNotMatch(tools[0].textContent, /Read-only/);
    assert.match(tools[1].textContent, /Read-only/);
    assert.match(tools[1].textContent, /Verifiers$/);
    const point = container.querySelector(".fdy-foundry-skill-guidance li");
    assert.equal(point.querySelector("code").textContent, "cancel_session");
    assert.match(
      container.querySelector(".fdy-foundry-skill-revisions").textContent,
      /Claude Code revision 4 · Codex revision 4/,
    );
    const button = (label) =>
      [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label,
      );
    await act(async () => button("Skills").click());
    assert.equal(window.location.pathname, "/workspace/skills");
    await act(async () => button("View SKILL.md").click());
    const manifest = document.body.querySelector(".fdy-foundry-skill-manifest");
    assert.equal(manifest.textContent, detail.manifest);
    assert.match(document.body.textContent, /revision 4/);
  } finally {
    await view.unmount();
    globalThis.fetch = original;
  }
});

test("a failed read says why and offers to try again", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: "server unreachable" }), {
          status: 502,
        })
      : new Response(JSON.stringify(detail), { status: 200 });
  };
  const view = await render(createElement(FoundrySkillPage));
  try {
    await settle();
    const alert = view.container.querySelector("[role=alert]");
    assert.match(alert.textContent, /could not be read/);
    await act(async () => alert.querySelector("button").click());
    await settle();
    assert.equal(calls, 2);
    assert.equal(
      view.container.querySelectorAll(".fdy-foundry-skill-tools > li").length,
      2,
    );
  } finally {
    await view.unmount();
    globalThis.fetch = original;
  }
});

test("only Foundry's own foundry skill links to its page", async () => {
  const view = await render(
    createElement(OfficialSkillsSection, {
      providerHealth: [
        {
          provider: "claude",
          officialSkills: [{ name: "pdf", description: "Read PDFs" }],
        },
      ],
      builtinSkills: [
        {
          runtime: "claude",
          name: "foundry",
          description: "Work with Foundry.",
          source: "Foundry",
        },
        {
          runtime: "claude",
          name: "skill-creator",
          description: "Make skills.",
          source: "Anthropic skills",
        },
      ],
    }),
  );
  try {
    const links = [
      ...view.container.querySelectorAll(".fdy-official-skills-open"),
    ];
    assert.equal(links.length, 1);
    assert.equal(
      links[0].getAttribute("aria-label"),
      "What the foundry skill gives agents",
    );
    await act(async () => links[0].click());
    assert.equal(window.location.pathname, "/workspace/skills/foundry");
  } finally {
    await view.unmount();
  }
});
