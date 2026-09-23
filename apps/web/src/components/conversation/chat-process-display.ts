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

interface ProcessSummaryPhrase {
  continuation: string;
  initial: string;
}

export function plainProcessLine(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return (
    value
      .replace(/<image\b[^>]*>/gi, "image attached")
      .replace(/[`*_>#]/g, " ")
      .replace(/^\s*[-+]\s+/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function completedProcessTitle(title: string): string {
  const trimmed = title.trim();
  const exactTitles: Record<string, string> = {
    正在思考: "思考完成",
    正在运行: "已运行",
    处理中: "已处理",
  };
  const exact = exactTitles[trimmed];
  if (exact) {
    return exact;
  }
  if (trimmed.startsWith("正在")) {
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
  return /^(?:正在|处理中|Running\b|Using\b|Reading\b|Searching\b|Editing\b)/i.test(
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
      label: shellTool ? "Shell" : item.snippet,
    };
  }
  const content = plainCodeBlockContent(body);
  if (!content) {
    return undefined;
  }
  return {
    content,
    label: shellTool ? "Shell" : item.snippet || "Tool",
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
 * Completed turns also rewrite any orphaned "正在…" labels to result language.
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
    return { initial: "已读取文件", continuation: "读取了文件" };
  }
  if (/命令|command|\bran\b/.test(normalized)) {
    return { initial: "已运行命令", continuation: "运行了命令" };
  }
  if (/搜索|search/.test(normalized)) {
    return { initial: "已完成搜索", continuation: "完成了搜索" };
  }
  if (/编辑.*文件|file change|edited.*file/.test(normalized)) {
    return { initial: "已编辑文件", continuation: "编辑了文件" };
  }
  if (/工具|tool/.test(normalized)) {
    return { initial: "已调用工具", continuation: "调用了工具" };
  }
  if (/思考|reason/.test(normalized)) {
    return { initial: "已完成思考", continuation: "完成了思考" };
  }
  return undefined;
}

export function processDisplaySummaryTitle(
  rows: ProcessDisplayRow[],
  fallbackTitle: string,
  streaming: boolean,
): string {
  if (streaming) {
    return rows[rows.length - 1]?.title || fallbackTitle || "正在运行";
  }
  const phrases: ProcessSummaryPhrase[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const phrase = summaryPhrase(row.title);
    if (!phrase || seen.has(phrase.initial)) {
      continue;
    }
    seen.add(phrase.initial);
    phrases.push(phrase);
  }
  if (phrases.length === 0) {
    return completedProcessTitle(fallbackTitle) || "已处理";
  }
  if (phrases.length === 1) {
    return phrases[0]?.initial ?? "已处理";
  }
  const visible = phrases.slice(0, 3);
  const first = visible[0]?.initial ?? "已处理";
  const rest = visible.slice(1).map((phrase) => phrase.continuation);
  if (rest.length === 1) {
    return `${first}并${rest[0]}`;
  }
  return `${first}、${rest.slice(0, -1).join("、")}并${rest.at(-1)}`;
}
