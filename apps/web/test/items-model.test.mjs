// Day, week and range boundaries are the browser's: pin a zone eight hours
// from UTC so "today" differs from the UTC day.
process.env.TZ = "Asia/Shanghai";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const model = await import("../src/features/personal-agent/items-model.ts");

// Thursday 2026-10-15 09:00 in Shanghai.
const now = new Date("2026-10-15T01:00:00Z");

function item(id, fields = {}) {
  return {
    id,
    intentRevision: 1,
    revision: 1,
    owner: "person",
    text: `item ${id}`,
    remind: false,
    status: "open",
    createdAt: "2026-10-10T01:00:00Z",
    updatedAt: "2026-10-10T01:00:00Z",
    helpers: [],
    ...fields,
  };
}

function helper(status, fields = {}) {
  return {
    sessionId: `sess_${status}`,
    status,
    readOnly: false,
    ...fields,
  };
}

test("the day and the week start at local midnight, the week on Monday", () => {
  assert.equal(
    model.startOfLocalDay(now).toISOString(),
    "2026-10-14T16:00:00.000Z",
  );
  assert.equal(
    model.startOfLocalWeek(now).toISOString(),
    "2026-10-11T16:00:00.000Z",
  );
  // Sunday 2026-10-18 belongs to the week that began on Monday the 12th.
  assert.equal(
    model.startOfLocalWeek(new Date("2026-10-18T06:00:00Z")).toISOString(),
    "2026-10-11T16:00:00.000Z",
  );
});

test("ranges are half-open windows in local time; all has no bounds", () => {
  assert.deepEqual(model.rangeFor("today", now), {
    from: "2026-10-14T16:00:00.000Z",
    to: "2026-10-15T16:00:00.000Z",
  });
  assert.deepEqual(model.rangeFor("week", now), {
    from: "2026-10-11T16:00:00.000Z",
    to: "2026-10-18T16:00:00.000Z",
  });
  assert.deepEqual(model.rangeFor("lastWeek", now), {
    from: "2026-10-04T16:00:00.000Z",
    to: "2026-10-11T16:00:00.000Z",
  });
  assert.deepEqual(model.rangeFor("month", now), {
    from: "2026-09-30T16:00:00.000Z",
    to: "2026-10-31T16:00:00.000Z",
  });
  assert.deepEqual(model.rangeFor("all", now), {});
});

test("a custom range includes both calendar days and ignores an unreadable side", () => {
  assert.deepEqual(model.customRange("2026-10-01", "2026-10-03"), {
    from: "2026-09-30T16:00:00.000Z",
    to: "2026-10-03T16:00:00.000Z",
  });
  assert.deepEqual(model.customRange("", "2026-10-03"), {
    to: "2026-10-03T16:00:00.000Z",
  });
  assert.deepEqual(model.customRange("10/01/2026", ""), {});
});

test("the mark follows the owner, then the helper that works on the item", () => {
  assert.deepEqual(model.itemMark(item("a")), { kind: "person" });
  assert.deepEqual(model.itemMark(item("b", { owner: "assistant" })), {
    kind: "assistant",
    state: "idle",
  });
  const running = helper("running");
  assert.deepEqual(
    model.itemMark(item("c", { owner: "assistant", helpers: [running] })),
    { kind: "assistant", state: "running", helper: running },
  );
  const asking = helper("asking");
  assert.equal(
    model.itemMark(
      item("d", {
        owner: "assistant",
        helpers: [helper("queued"), asking],
      }),
    ).state,
    "asking",
  );
  // A finished helper no longer makes the item busy.
  assert.equal(
    model.itemMark(item("e", { owner: "assistant", helpers: [helper("done")] }))
      .state,
    "idle",
  );
});

test("closed today is what the card folds: done or dropped since local midnight", () => {
  const items = [
    item("open", { closedAt: undefined }),
    item("done-today", {
      status: "done",
      closedAt: "2026-10-14T20:00:00Z",
    }),
    item("dropped-yesterday", {
      status: "dropped",
      closedAt: "2026-10-13T20:00:00Z",
    }),
    item("done-before-midnight", {
      status: "done",
      closedAt: "2026-10-14T15:59:59Z",
    }),
  ];
  assert.deepEqual(
    model.closedToday(items, now).map((entry) => entry.id),
    ["done-today"],
  );
});

test("items group by the local day of their last update, newest day first", () => {
  const items = [
    item("today", { updatedAt: "2026-10-15T00:30:00Z" }),
    item("today-later", { updatedAt: "2026-10-14T20:00:00Z" }),
    item("yesterday", { updatedAt: "2026-10-14T10:00:00Z" }),
    item("earlier", { updatedAt: "2026-10-01T10:00:00Z" }),
  ];
  const groups = model.groupByDay(items, now);
  assert.deepEqual(
    groups.map((group) => group.relation),
    ["today", "yesterday", "earlier"],
  );
  assert.deepEqual(
    groups[0].items.map((entry) => entry.id),
    ["today", "today-later"],
  );
});

test("the summary headline is its first line without Markdown marks", () => {
  assert.equal(model.summaryHeadline(undefined), "");
  assert.equal(model.summaryHeadline("\n## 结果\n- 已部署 dev\n"), "结果");
  assert.equal(model.summaryHeadline("  - 第一条\n第二条"), "第一条");
});

test("linked session ids gather every item helper, so the card can hide them", () => {
  const ids = model.linkedSessionIds([
    item("a", { helpers: [helper("running", { sessionId: "sess_a" })] }),
    item("b", { helpers: [helper("done", { sessionId: "sess_b" })] }),
  ]);
  assert.deepEqual([...ids].sort(), ["sess_a", "sess_b"]);
});

test("the review is Markdown built from counts and the items under each status", () => {
  const labels = {
    title: "Items review",
    range: "2026-10-11 – 2026-10-17",
    counts: {
      created: "New",
      done: "Done",
      open: "Open",
      dropped: "Not doing it",
    },
    statuses: { open: "Open", done: "Done", dropped: "Not doing it" },
    owners: { person: "You", assistant: "Assistant" },
    updated: "Updated",
    closed: "Finished",
    empty: "No items in this range.",
  };
  const markdown = model.reportMarkdown(
    {
      from: "2026-10-11T16:00:00.000Z",
      to: "2026-10-18T16:00:00.000Z",
      counts: { created: 2, done: 1, open: 1, dropped: 0 },
      groups: [
        {
          status: "open",
          items: [
            item("open", {
              owner: "assistant",
              summary: "## Progress\n- waiting for CI",
              updatedAt: "2026-10-14T01:00:00Z",
            }),
          ],
        },
        {
          status: "done",
          items: [
            item("done", {
              status: "done",
              text: "deploy llm-gateway",
              updatedAt: "2026-10-13T01:00:00Z",
              closedAt: "2026-10-13T01:00:00Z",
            }),
          ],
        },
        { status: "dropped", items: [] },
      ],
    },
    labels,
  );
  assert.match(markdown, /^# Items review\n/);
  assert.match(markdown, /New 2 · Done 1 · Open 1 · Not doing it 0/);
  assert.match(markdown, /## Open \(1\)/);
  assert.match(
    markdown,
    /- \*\*item open\*\* \(Assistant; Updated 2026-10-14\)/,
  );
  assert.match(
    markdown,
    /- \*\*deploy llm-gateway\*\* \(You; Updated 2026-10-13; Finished 2026-10-13\)/,
  );
  assert.match(markdown, /\n {2}Progress\n/);
  assert.match(markdown, /- \*\*deploy llm-gateway\*\* \(You;/);
  assert.doesNotMatch(markdown, /## Not doing it/);
});
