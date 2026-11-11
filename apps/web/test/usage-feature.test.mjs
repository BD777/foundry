import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "http://127.0.0.1/usage" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "NodeFilter",
  "DOMRect",
  "PopStateEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.SVGElement.prototype.getBBox = () => ({
  height: 12,
  width: 40,
  x: 0,
  y: 0,
});
window.SVGElement.prototype.getComputedTextLength = () => 40;

const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { createRoot } = await import("react-dom/client");
const { UsageFeature } = await import("../src/features/usage/index.ts");
const { UsageTrend } =
  await import("../src/features/usage/usage-trend.tsx");
const { groupedUsageTrend, usageBuckets } =
  await import("../src/features/usage/usage-model.ts");

const currentUser = {
  createdAt: "2026-01-01T00:00:00Z",
  displayName: "Alice Admin",
  id: "user_a",
  role: "admin",
  updatedAt: "2026-01-01T00:00:00Z",
  username: "alice",
};
const users = [
  currentUser,
  {
    ...currentUser,
    displayName: "Bob Member",
    id: "user_b",
    role: "member",
    username: "bob",
  },
];
const overview = [
  point("2026-11-09", 2, 0, 1300, 380, 0.18, {
    estimatedCostUsd: 0.05,
    medianTokensPerSecond: 24,
    ttftP50Ms: 820,
  }),
  point("2026-11-10", 3, 0, 2900, 720, 0.32, {
    estimatedCostUsd: 0.09,
    medianTokensPerSecond: 31,
    ttftP50Ms: 640,
  }),
];
const breakdown = [
  {
    ...point("2026-11-09", 2, 0, 1300, 380, 0.18, {
      estimatedCostUsd: 0.05,
      medianTokensPerSecond: 24,
      ttftP50Ms: 820,
    }),
    entry: "chat",
  },
  {
    ...point("2026-11-10", 3, 0, 2900, 720, 0.32, {
      estimatedCostUsd: 0.09,
      medianTokensPerSecond: 31,
      ttftP50Ms: 640,
    }),
    entry: "issue",
  },
];

function point(
  bucket,
  turns,
  requests,
  inputTokens,
  outputTokens,
  costUsd,
  {
    estimatedCostUsd,
    medianTokensPerSecond,
    ttftP50Ms,
  },
) {
  return {
    bucket,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costSources: [
      {
        costUsd: costUsd - estimatedCostUsd,
        source: "reported",
        turns: turns - 1,
      },
      { costUsd: estimatedCostUsd, source: "estimated", turns: 1 },
    ],
    costUsd,
    inputTokens,
    medianTokensPerSecond,
    outputTokens,
    reasoningTokens: 0,
    requests,
    ttftP50Ms,
    ttftP90Ms: ttftP50Ms + 200,
    turns,
  };
}

const requests = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requests.push(url);
  if (url.pathname === "/api/users") {
    return json(users);
  }
  if (url.pathname === "/api/usage-stats") {
    const groupBy = url.searchParams.get("groupBy");
    const items = groupBy ? breakdown : overview;
    return json({
      from: url.searchParams.get("from"),
      granularity: url.searchParams.get("granularity"),
      groupBy: groupBy ? [groupBy] : [],
      items,
      limit: 500,
      offset: 0,
      to: url.searchParams.get("to"),
      total: items.length,
    });
  }
  return json({ error: `no fixture for ${url.pathname}` }, 404);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = predicate();
    if (result) return result;
    await settle();
  }
  assert.fail(
    `timed out waiting for ${label}; buttons: ${[
      ...document.body.querySelectorAll("button"),
    ]
      .map((node) => node.textContent.trim())
      .join(" | ")}`,
  );
}

function button(container, text) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
  assert.ok(
    found,
    `button ${text}: ${[...container.querySelectorAll("button")]
      .map((node) => node.textContent.trim())
      .join(" | ")}`,
  );
  return found;
}

test("usage renders totals, sources and breakdown, then refetches for each filter", async () => {
  requests.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(UsageFeature, {
          currentUser,
          devices: [{ id: "dev_a", label: "Studio" }],
          isAdmin: true,
          workspaces: [{ id: "ws_a", name: "Alpha" }],
        }),
      ),
    );
    await waitFor(
      () => container.textContent.includes("Breakdown"),
      "the usage breakdown",
    );

    const text = container.textContent;
    assert.match(text, /Usage statistics/);
    assert.match(text, /Input tokens/);
    assert.match(text, /Estimated \d+(?:\.\d+)?% of cost/);
    assert.match(text, /Reported/);
    assert.match(text, /Estimated/);
    assert.match(text, /Chat/);
    assert.match(text, /Issue/);
    assert.match(text, /Usage over time/);
    assert.match(
      container.querySelector('section[aria-label="Usage statistics"]').className,
      /grid-cols-4/,
    );
    assert.equal(
      container.querySelectorAll("[data-usage-trend]").length,
      1,
    );
    assert.ok(container.querySelector("[data-chart]"));
    const tokens = [...container.querySelectorAll('[role="radio"]')].find(
      (node) => node.textContent.trim() === "Tokens",
    );
    assert.ok(tokens);
    await act(async () => tokens.click());
    assert.equal(tokens.getAttribute("aria-checked"), "true");
    const requestsMetric = [...container.querySelectorAll('[role="radio"]')].find(
      (node) => node.textContent.trim() === "Requests",
    );
    assert.ok(requestsMetric);
    await act(async () => requestsMetric.click());
    assert.equal(requestsMetric.getAttribute("aria-checked"), "true");
    await waitFor(
      () => container.textContent.includes("No data for this metric"),
      "the empty requests chart",
    );
    await waitFor(
      () => requests.filter((url) => url.pathname === "/api/users").length === 1,
      "the people request",
    );

    const person = await waitFor(() => {
      const node = container.querySelector('button[aria-label^="Person"]');
      return node && !node.disabled ? node : undefined;
    }, "the people picker");
    await act(async () =>
      person.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      ),
    );
    const bob = await waitFor(
      () =>
        [...document.body.querySelectorAll('[role="menuitemradio"]')].find(
          (node) => node.textContent.includes("Bob Member"),
        ),
      "the Admin's person option",
    );
    await act(async () => bob.click());
    await waitFor(
      () =>
        requests.some(
          (url) =>
            url.pathname === "/api/usage-stats" &&
            url.searchParams.get("userId") === "user_b",
        ),
      "the person filter request",
    );

    const groupBy = container.querySelector('button[aria-label^="Group by"]');
    assert.ok(groupBy);
    await act(async () =>
      groupBy.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      ),
    );
    const model = await waitFor(
      () =>
        [...document.body.querySelectorAll('[role="menuitemradio"]')].find(
          (node) => node.textContent.trim() === "Model",
        ),
      "the Model group option",
    );
    await act(async () => model.click());
    await waitFor(
      () =>
        requests.some(
          (url) =>
            url.pathname === "/api/usage-stats" &&
            url.searchParams.get("groupBy") === "model",
        ),
      "the model group request",
    );

    await act(async () => button(container, "30 days").click());
    await waitFor(
      () =>
        requests.some(
          (url) =>
            url.pathname === "/api/usage-stats" &&
            url.searchParams.get("granularity") === "day",
        ),
      "the day request",
    );
    await act(async () => button(container, "Hour").click());
    await waitFor(
      () =>
        requests.some(
          (url) =>
            url.pathname === "/api/usage-stats" &&
            url.searchParams.get("granularity") === "hour",
        ),
      "the hour request",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((node) => node.remove());
  }
});

test("a member sees only their own scope and no person picker", async () => {
  requests.length = 0;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(UsageFeature, {
          currentUser: { ...currentUser, role: "member" },
          devices: [],
          isAdmin: false,
          workspaces: [],
        }),
      ),
    );
    await waitFor(
      () => container.textContent.includes("Breakdown"),
      "the member's usage breakdown",
    );
    assert.match(container.textContent, /Showing your usage/);
    assert.equal(
      container.querySelector('button[aria-label^="Person"]'),
      null,
    );
    assert.equal(requests.filter((url) => url.pathname === "/api/users").length, 0);
    assert.ok(
      requests
        .filter((url) => url.pathname === "/api/usage-stats")
        .every((url) => !url.searchParams.has("userId")),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a single time bucket uses stacked bars instead of an invisible area", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(UsageTrend, {
          dimension: "entry",
          dimensionName: "Entry",
          from: new Date("2026-11-10T00:00:00.000Z"),
          granularity: "day",
          groupLabel: (key) => key,
          items: [
            {
              ...point("2026-11-10", 2, 0, 120, 30, 0.1, {
                estimatedCostUsd: 0.1,
                medianTokensPerSecond: 20,
                ttftP50Ms: 500,
              }),
              entry: "chat",
            },
            {
              ...point("2026-11-10", 1, 0, 60, 20, 0.05, {
                estimatedCostUsd: 0.05,
                medianTokensPerSecond: 18,
                ttftP50Ms: 650,
              }),
              entry: "issue",
            },
          ],
          to: new Date("2026-11-11T00:00:00.000Z"),
        }),
      ),
    );
    const chart = await waitFor(
      () => container.querySelector('[data-chart-kind="bars"]'),
      "the single-bucket bar chart",
    );
    assert.ok(chart);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("usage trend fills every selected bucket with zero for missing series", () => {
  const from = new Date("2026-11-01T00:00:00.000Z");
  const to = new Date("2026-11-04T00:00:00.000Z");
  const buckets = usageBuckets(from, to, "day");
  assert.deepEqual(buckets, ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(
    usageBuckets(
      new Date("2026-11-01T10:12:00.000Z"),
      new Date("2026-11-01T13:00:00.000Z"),
      "hour",
    ),
    [
      "2026-11-01T10:00:00Z",
      "2026-11-01T11:00:00Z",
      "2026-11-01T12:00:00Z",
    ],
  );

  const trend = groupedUsageTrend(
    [
      {
        ...point("2026-11-01", 5, 0, 100, 20, 0.1, {
          estimatedCostUsd: 0.1,
          medianTokensPerSecond: 20,
          ttftP50Ms: 500,
        }),
        entry: "chat",
      },
      {
        ...point("2026-11-03", 2, 0, 60, 10, 0.05, {
          estimatedCostUsd: 0.05,
          medianTokensPerSecond: 15,
          ttftP50Ms: 700,
        }),
        entry: "issue",
      },
    ],
    "entry",
    "turns",
    buckets,
    (key) => key,
  );
  const chat = trend.series.find((series) => series.label === "chat");
  const issue = trend.series.find((series) => series.label === "issue");
  assert.ok(chat);
  assert.ok(issue);
  assert.deepEqual(
    trend.data.map((row) => row[chat.key]),
    [5, 0, 0],
  );
  assert.deepEqual(
    trend.data.map((row) => row[issue.key]),
    [0, 0, 2],
  );
});
