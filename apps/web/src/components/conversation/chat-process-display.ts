import { i18n } from "../../i18n";

export interface ProcessDisplayItem {
  id?: string;
  kind?: string;
  callId?: string;
  status?: "running" | "completed" | "failed";
  detail: string;
  title: string;
}

export interface ProcessDisplayRow extends ProcessDisplayItem {
  snippet: string;
}

export interface CompactProcessToolDetail {
  content: string;
  label: string;
}

type ProcessSummaryPhrase =
  | "readFiles"
  | "ranCommands"
  | "searched"
  | "editedFiles"
  | "calledTools"
  | "thought";

export function plainProcessLine(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return (
    value
      .replace(/<image\b[^>]*>/gi, i18n.t("conversation:process.imageAttached"))
      .replace(/[`*_>#]/g, " ")
      .replace(/^\s*[-+]\s+/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Rewrites an agent-provided in-progress title into result language, in the
 * language the agent wrote it in. The titles are data, not interface copy.
 */
export function completedProcessTitle(title: string): string {
  const trimmed = title.trim();
  // i18n-ignore: rewrites agent-provided titles, which are data
  const exactTitles: Record<string, string> = {
    // i18n-ignore: agent-provided title
    正在思考: "思考完成",
    // i18n-ignore: agent-provided title
    正在运行: "已运行",
    // i18n-ignore: agent-provided title
    处理中: "已处理",
    "Working…": "Processed",
  };
  const exact = exactTitles[trimmed];
  if (exact) {
    return exact;
  }
  // i18n-ignore: matches agent-provided titles
  if (trimmed.startsWith("正在")) {
    // i18n-ignore: rewrites an agent-provided title
    return `已${trimmed.slice(2)}`;
  }
  const englishPrefixes: Array<[RegExp, string]> = [
    [/^Running\b/i, "Ran"],
    [/^Using\b/i, "Used"],
    [/^Reading\b/i, "Read"],
    [/^Searching\b/i, "Searched"],
    [/^Editing\b/i, "Edited"],
  ];
  for (const [pattern, replacement] of englishPrefixes) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, replacement);
    }
  }
  return trimmed;
}

function isInProgressTitle(title: string): boolean {
  return /^(?:正在|处理中|Working\b|Running\b|Using\b|Reading\b|Searching\b|Editing\b)/i.test(
    title.trim(),
  );
}

function processIdentity(item: ProcessDisplayItem): string {
  return `${completedProcessTitle(item.title).toLowerCase()}\u0000${plainProcessLine(item.detail).toLowerCase()}`;
}

function stripEmptyDetailSections(detail: string): string {
  return detail
    .replace(
      /(^|\n{2,})(?:Arguments|Input|Result|Output)\s*\n+```(?:json)?\s*(?:\{\}|\[\]|null)?\s*```(?=\n{2,}|$)/gi,
      "$1",
    )
    .replace(
      /(^|\n{2,})```(?:json)?\s*(?:\{\}|\[\]|null)?\s*```(?=\n{2,}|$)/gi,
      "$1",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detailAfterSnippet(detail: string, snippet: string): string {
  if (!snippet) {
    return detail.trim();
  }
  const lines = detail.split(/\r?\n/);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0) {
    return "";
  }
  return lines
    .slice(firstContentLine + 1)
    .join("\n")
    .trim();
}

function plainCodeBlockContent(value: string): string {
  return value
    .replace(/```[\w-]*\s*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function firstFencedJSON(value: string): Record<string, unknown> | undefined {
  const match = value.match(/```json\s*([\s\S]*?)```/i);
  const source = match?.[1]?.trim();
  if (!source) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function compactProcessToolDetail(
  item: ProcessDisplayRow,
): CompactProcessToolDetail | undefined {
  if (!item.detail) {
    return undefined;
  }
  const title = item.title.toLowerCase();
  const isCommand = /命令|command|\bran\b/.test(title);
  const isTool = /工具|tool/.test(title);
  if (!isCommand && !isTool) {
    return undefined;
  }

  const body = detailAfterSnippet(item.detail, item.snippet);
  if (isCommand) {
    const output = plainCodeBlockContent(body);
    return {
      content: `$ ${item.snippet}${output ? `\n\n${output}` : ""}`,
      // i18n-ignore: tool kind name, same in every language
      label: "Shell",
    };
  }

  const toolInput = firstFencedJSON(body);
  const command = [toolInput?.command, toolInput?.cmd].find(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  const shellTool = /^(?:bash|shell|exec|command)$/i.test(item.snippet);
  if (command) {
    return {
      content: `$ ${command.trim()}`,
      // i18n-ignore: tool kind name, same in every language
      label: shellTool ? "Shell" : item.snippet,
    };
  }
  const content = plainCodeBlockContent(body);
  if (!content) {
    return undefined;
  }
  return {
    content,
    label: shellTool
      ? // i18n-ignore: tool kind name, same in every language
        "Shell"
      : item.snippet || i18n.t("conversation:process.tool"),
  };
}

function hasMeaningfulDetail(detail: string, snippet: string): boolean {
  const remainder = detailAfterSnippet(detail, snippet)
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/^(?:Arguments|Input|Result|Output)\s*$/gim, "")
    .trim();
  return Boolean(
    remainder && !/^(?:\{\}|\[\]|null|undefined)$/i.test(remainder),
  );
}

/**
 * Collapses matching start/completion lifecycle events into one display row.
 * Completed turns also rewrite any orphaned in-progress labels to result language.
 */
export function processDisplayRows(
  items: ProcessDisplayItem[] | undefined,
  streaming: boolean,
): ProcessDisplayRow[] {
  if (!items) {
    return [];
  }
  const compacted: ProcessDisplayItem[] = [];
  const pending = new Map<string, number[]>();
  const identities = new Map<string, number>();
  let previous: ProcessDisplayItem | undefined;

  for (const item of items) {
    // Status heartbeats are notifications, not separate tool executions.
    const duplicateStatus =
      /^(?:正在请求模型|正在压缩上下文)$/.test(item.title.trim()) &&
      previous?.title.trim() === item.title.trim() &&
      previous.detail.trim() === item.detail.trim();
    previous = item;
    if (duplicateStatus) {
      continue;
    }
    // Typed provider identities take precedence over legacy title matching.
    const identity = item.callId
      ? `call:${item.callId}`
      : item.status && item.id
        ? `item:${item.id}`
        : undefined;
    if (identity) {
      const index = identities.get(identity);
      if (index !== undefined) {
        const prior = compacted[index]!;
        compacted[index] = {
          ...item,
          id: prior.id,
          detail:
            item.callId && prior.id !== item.id && prior.detail !== item.detail
              ? `${prior.detail}\n\nOutput\n\n${item.detail}`
              : item.detail,
        };
      } else {
        identities.set(identity, compacted.length);
        compacted.push(item);
      }
      continue;
    }
    const key = processIdentity(item);
    if (isInProgressTitle(item.title)) {
      const index = compacted.push(item) - 1;
      pending.set(key, [...(pending.get(key) ?? []), index]);
      continue;
    }
    const matches = pending.get(key);
    const pendingIndex = matches?.shift();
    if (pendingIndex !== undefined) {
      const prior = compacted[pendingIndex];
      compacted[pendingIndex] = prior?.id ? { ...item, id: prior.id } : item;
      if (matches?.length === 0) {
        pending.delete(key);
      }
      continue;
    }
    compacted.push(item);
  }

  return compacted.map((item) => {
    const snippet = plainProcessLine(item.detail);
    const detail = stripEmptyDetailSections(item.detail);
    return {
      ...item,
      detail: hasMeaningfulDetail(detail, snippet) ? detail : "",
      snippet,
      title: streaming ? item.title.trim() : completedProcessTitle(item.title),
    };
  });
}

function summaryPhrase(title: string): ProcessSummaryPhrase | undefined {
  const normalized = completedProcessTitle(title).toLowerCase();
  if (/读取.*文件|read.*file/.test(normalized)) {
    return "readFiles";
  }
  if (/命令|command|\bran\b/.test(normalized)) {
    return "ranCommands";
  }
  if (/搜索|search/.test(normalized)) {
    return "searched";
  }
  if (/编辑.*文件|file change|edited.*file/.test(normalized)) {
    return "editedFiles";
  }
  if (/工具|tool/.test(normalized)) {
    return "calledTools";
  }
  if (/思考|reason/.test(normalized)) {
    return "thought";
  }
  return undefined;
}

export function processDisplaySummaryTitle(
  rows: ProcessDisplayRow[],
  fallbackTitle: string,
  streaming: boolean,
): string {
  if (streaming) {
    return (
      rows[rows.length - 1]?.title ||
      fallbackTitle ||
      i18n.t("conversation:process.running")
    );
  }
  const phrases: ProcessSummaryPhrase[] = [];
  for (const row of rows) {
    const phrase = summaryPhrase(row.title);
    if (phrase && !phrases.includes(phrase)) {
      phrases.push(phrase);
    }
  }
  const [first, second, third] = phrases;
  if (!first) {
    return (
      completedProcessTitle(fallbackTitle) ||
      i18n.t("conversation:process.processed")
    );
  }
  const initial = i18n.t(`conversation:process.summary.${first}.initial`);
  if (!second) {
    return initial;
  }
  const continuation = (phrase: ProcessSummaryPhrase) =>
    i18n.t(`conversation:process.summary.${phrase}.continuation`);
  return third
    ? i18n.t("conversation:process.summary.three", {
        first: initial,
        second: continuation(second),
        third: continuation(third),
      })
    : i18n.t("conversation:process.summary.two", {
        first: initial,
        second: continuation(second),
      });
}
