import type { ChatMessageItem } from "./conversation-types";

const CHAT_TURN_QUERY_PREVIEW_LIMIT = 480;
const CHAT_TURN_ACCESSIBLE_LABEL_LIMIT = 160;
const CHAT_TURN_LATEST_TARGET_GAP_PX = 1;

export interface ChatTurnAnchor {
  accessibleLabel: string;
  id: string;
  messageIndex: number;
  query: string;
}

export interface ChatTurnMeasurement {
  start: number;
}

export function chatTurnNavigationLeavesLatest(
  targetOffset: number | undefined,
  maxScrollOffset: number,
): boolean {
  if (targetOffset === undefined || !Number.isFinite(targetOffset)) {
    return true;
  }
  return (
    targetOffset < Math.max(0, maxScrollOffset) - CHAT_TURN_LATEST_TARGET_GAP_PX
  );
}

function textFromNode(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return `${value}`;
  }
  if (Array.isArray(value)) {
    return value.map(textFromNode).filter(Boolean).join(" ");
  }
  return "";
}

function truncateText(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) {
    return value;
  }
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function normalizeChatTurnQuery(value: unknown): string {
  return textFromNode(value).replace(/\s+/g, " ").trim();
}

export function buildChatTurnAnchors(
  messages: readonly ChatMessageItem[],
): ChatTurnAnchor[] {
  const anchors: ChatTurnAnchor[] = [];
  messages.forEach((message, messageIndex) => {
    if (
      message.role !== "user" ||
      (message.kind !== undefined && message.kind !== "message")
    ) {
      return;
    }

    const normalized = normalizeChatTurnQuery(message.text);
    const attachmentLabel = message.attachments
      ?.map((attachment) => attachment.name.trim())
      .filter(Boolean)
      .join(", ");
    const query = normalized || attachmentLabel || "User message";
    anchors.push({
      accessibleLabel: truncateText(query, CHAT_TURN_ACCESSIBLE_LABEL_LIMIT),
      id: message.id,
      messageIndex,
      query: truncateText(query, CHAT_TURN_QUERY_PREVIEW_LIMIT),
    });
  });
  return anchors;
}

export function chatTurnReadingInset(viewportHeight: number): number {
  return Math.min(160, Math.max(72, viewportHeight * 0.22));
}

/** Rendered items include overscan; locate the item at the actual reading line. */
export function chatReadingMessageIndex(
  items: readonly { index: number; offset: number }[],
  probe: number,
): number {
  let low = 0;
  let high = items.length - 1;
  let result = items[0]?.index ?? 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const item = items[middle];
    if (item && item.offset <= probe) {
      result = item.index;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

export function findActiveChatTurnIndex(
  anchors: readonly ChatTurnAnchor[],
  measurements: readonly (ChatTurnMeasurement | undefined)[],
  probe: number,
  options: { atEnd?: boolean; atStart?: boolean } = {},
): number {
  if (anchors.length === 0) {
    return -1;
  }
  if (options.atStart) {
    return 0;
  }
  if (options.atEnd) {
    return anchors.length - 1;
  }

  let activeIndex = 0;
  let low = 0;
  let high = anchors.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const anchor = anchors[middle];
    const start =
      anchor === undefined
        ? undefined
        : measurements[anchor.messageIndex]?.start;
    if (start === undefined || !Number.isFinite(start)) {
      high = middle - 1;
      continue;
    }
    if (start <= probe) {
      activeIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return activeIndex;
}

export function findActiveChatTurnIndexForMessage(
  anchors: readonly ChatTurnAnchor[],
  messageIndex: number,
  atEnd = false,
): number {
  if (anchors.length === 0) {
    return -1;
  }
  if (atEnd) {
    return anchors.length - 1;
  }

  let activeIndex = 0;
  let low = 0;
  let high = anchors.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const anchor = anchors[middle];
    if (!anchor || anchor.messageIndex > messageIndex) {
      high = middle - 1;
    } else {
      activeIndex = middle;
      low = middle + 1;
    }
  }
  return activeIndex;
}

export function sampleChatTurnIndexes(
  count: number,
  limit: number,
  pinnedIndexes: readonly number[] = [],
): number[] {
  const boundedCount = Math.max(0, Math.floor(count));
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedCount === 0 || boundedLimit === 0) {
    return [];
  }
  if (boundedCount <= boundedLimit) {
    return Array.from({ length: boundedCount }, (_, index) => index);
  }

  const selected = new Set<number>([0, boundedCount - 1]);
  for (const index of pinnedIndexes) {
    if (Number.isInteger(index) && index >= 0 && index < boundedCount) {
      selected.add(index);
    }
  }

  while (selected.size < boundedLimit) {
    const sorted = [...selected].sort((left, right) => left - right);
    let bestGap = 0;
    let bestStart = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      const gap = current - previous;
      if (gap > bestGap) {
        bestGap = gap;
        bestStart = previous;
      }
    }
    if (bestGap <= 1) {
      break;
    }
    selected.add(bestStart + Math.floor(bestGap / 2));
  }

  return [...selected].sort((left, right) => left - right);
}
