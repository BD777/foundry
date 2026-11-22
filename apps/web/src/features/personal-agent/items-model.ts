import type {
  PersonalAgentItem,
  PersonalAgentItemHelper,
  PersonalAgentItemReport,
  PersonalAgentItemReportCounts,
  PersonalAgentItemStatus,
} from "@bd777/foundry-protocol";

// 「事项」 as the side card and the items page read it. Everything here is
// derived from stored facts (owner, status, helpers, times); nothing decides
// what an item means.

/** The helper states that mean work goes on or waits for the person. */
const liveHelperStatuses = new Set(["queued", "running", "asking"]);

/** What an item's lead mark shows: a person's checkbox, or the assistant's state. */
export type ItemMark =
  | { kind: "person" }
  | {
      kind: "assistant";
      state: "asking" | "running" | "idle";
      helper?: PersonalAgentItemHelper;
    };

/** The helper that is working on or waiting for the person about an item. */
export function liveHelper(
  item: PersonalAgentItem,
): PersonalAgentItemHelper | undefined {
  const live = item.helpers.filter((helper) =>
    liveHelperStatuses.has(helper.status),
  );
  return live.find((helper) => helper.status === "asking") ?? live[0];
}

export function itemMark(item: PersonalAgentItem): ItemMark {
  if (item.owner === "person") return { kind: "person" };
  const helper = liveHelper(item);
  if (!helper) return { kind: "assistant", state: "idle" };
  return {
    kind: "assistant",
    state: helper.status === "asking" ? "asking" : "running",
    helper,
  };
}

/** Local midnight at the start of `now`'s day. */
export function startOfLocalDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Local Monday 00:00 of the week `now` falls in (weeks start on Monday). */
export function startOfLocalWeek(now = new Date()): Date {
  const day = startOfLocalDay(now);
  const sinceMonday = (day.getDay() + 6) % 7;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() - sinceMonday,
  );
}

export type RangePreset = "today" | "week" | "lastWeek" | "month" | "all";

export const rangePresets: RangePreset[] = [
  "today",
  "week",
  "lastWeek",
  "month",
  "all",
];

/**
 * The half-open [from, to) window a preset covers, in RFC 3339; `all` has
 * no bounds. Items are matched by their last update.
 */
export function rangeFor(
  preset: RangePreset,
  now = new Date(),
): { from?: string; to?: string } {
  const day = startOfLocalDay(now);
  const week = startOfLocalWeek(now);
  const bounds = (from: Date, to: Date) => ({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  switch (preset) {
    case "today":
      return bounds(
        day,
        new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
      );
    case "week":
      return bounds(
        week,
        new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7),
      );
    case "lastWeek":
      return bounds(
        new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7),
        week,
      );
    case "month":
      return bounds(
        new Date(now.getFullYear(), now.getMonth(), 1),
        new Date(now.getFullYear(), now.getMonth() + 1, 1),
      );
    case "all":
      return {};
  }
}

/**
 * The window of a custom range: two local calendar days (YYYY-MM-DD), both
 * included. A missing or unreadable day leaves that side open.
 */
export function customRange(
  fromDay: string,
  toDay: string,
): { from?: string; to?: string } {
  const start = localDayFrom(fromDay);
  const end = localDayFrom(toDay);
  return {
    ...(start ? { from: start.toISOString() } : {}),
    ...(end
      ? {
          to: new Date(
            end.getFullYear(),
            end.getMonth(),
            end.getDate() + 1,
          ).toISOString(),
        }
      : {}),
  };
}

function localDayFrom(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Items closed since the start of today: the side card's 「已结束」 fold. */
export function closedToday(
  items: PersonalAgentItem[],
  now = new Date(),
): PersonalAgentItem[] {
  const dayStart = startOfLocalDay(now).getTime();
  return items.filter((item) => {
    if (item.status === "open" || !item.closedAt) return false;
    const closed = Date.parse(item.closedAt);
    return Number.isFinite(closed) && closed >= dayStart;
  });
}

/** Where the day of an item's last update sits, relative to today. */
export type DayRelation = "today" | "yesterday" | "earlier";

export interface ItemDayGroup {
  key: string;
  day: Date;
  relation: DayRelation;
  items: PersonalAgentItem[];
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Items grouped by the local day of their last update, newest day first;
 * each group keeps the order the server gave (newest updated first).
 */
export function groupByDay(
  items: PersonalAgentItem[],
  now = new Date(),
): ItemDayGroup[] {
  const today = startOfLocalDay(now);
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  const groups = new Map<string, ItemDayGroup>();
  for (const item of items) {
    const updated = new Date(item.updatedAt);
    if (!Number.isFinite(updated.getTime())) continue;
    const key = localDayKey(updated);
    let group = groups.get(key);
    if (!group) {
      const day = startOfLocalDay(updated);
      const relation: DayRelation =
        localDayKey(day) === localDayKey(today)
          ? "today"
          : localDayKey(day) === localDayKey(yesterday)
            ? "yesterday"
            : "earlier";
      group = { key, day, relation, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => b.day.getTime() - a.day.getTime());
}

/** The first non-empty line of a summary, without Markdown list or heading marks. */
export function summaryHeadline(summary: string | undefined): string {
  for (const line of (summary ?? "").split(/\r?\n/)) {
    const text = line.replace(/^\s*(?:#+|[-*+]|\d+\.)\s*/, "").trim();
    if (text) return text;
  }
  return "";
}

/** The sessions an item's helpers run; the side card hides them from 「其他执行」. */
export function linkedSessionIds(items: PersonalAgentItem[]): Set<string> {
  return new Set(items.flatMap((item) => item.helpers.map((h) => h.sessionId)));
}

export interface ReportLabels {
  title: string;
  /** The range, already formatted for the reader. */
  range: string;
  counts: Record<keyof PersonalAgentItemReportCounts, string>;
  statuses: Record<PersonalAgentItemStatus, string>;
  owners: Record<PersonalAgentItem["owner"], string>;
  updated: string;
  closed: string;
  empty: string;
}

function localDate(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * The review as Markdown, built only from the report's data: counts, then
 * the items under each status with the first line of their summary.
 */
export function reportMarkdown(
  report: PersonalAgentItemReport,
  labels: ReportLabels,
): string {
  const { counts } = report;
  const lines: string[] = [
    `# ${labels.title}`,
    "",
    labels.range,
    "",
    [
      `${labels.counts.created} ${counts.created}`,
      `${labels.counts.done} ${counts.done}`,
      `${labels.counts.open} ${counts.open}`,
      `${labels.counts.dropped} ${counts.dropped}`,
    ].join(" · "),
  ];
  const populated = report.groups.filter((group) => group.items.length > 0);
  if (populated.length === 0) lines.push("", labels.empty);
  for (const group of populated) {
    lines.push(
      "",
      `## ${labels.statuses[group.status]} (${group.items.length})`,
    );
    for (const item of group.items) {
      const dates = [
        `${labels.updated} ${localDate(item.updatedAt)}`,
        item.closedAt ? `${labels.closed} ${localDate(item.closedAt)}` : "",
      ].filter(Boolean);
      lines.push(
        "",
        `- **${item.text}** (${labels.owners[item.owner]}; ${dates.join("; ")})`,
      );
      const headline = summaryHeadline(item.summary);
      if (headline) lines.push(`  ${headline}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** "11/13 12:05 PM": the short local date and time, in the reader's language. */
export function shortWhen(iso: string | undefined, language: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return new Intl.DateTimeFormat(language, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/** The filter value of the items without a home workspace, the assistant's inbox. */
export const inboxFilter = "inbox";

/** The list query of a workspace filter: "", the inbox or a workspace id. */
export function itemsFilterQuery(filter: string): {
  workspace?: string;
  inbox?: boolean;
} {
  if (!filter) return {};
  return filter === inboxFilter ? { inbox: true } : { workspace: filter };
}
