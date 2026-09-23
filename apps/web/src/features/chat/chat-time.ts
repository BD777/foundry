/** Ignore missing/invalid legacy dates and keep the most recent known activity. */
export function latestChatTime(
  values: (string | undefined)[],
): string | undefined {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : undefined;
}

export function chatUpdateLabel(
  value: string | undefined,
  now = new Date(),
): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  const date = new Date(value);
  // Compare local calendar dates, not elapsed 24-hour periods (DST can vary).
  const calendarDay = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const days = calendarDay(now) - calendarDay(date);
  if (days <= 0) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return days === 1 ? "昨天" : `${days}天前`;
}

export interface ChatUpdateTime {
  label: string;
  title: string;
  dateTime?: string;
}

/** The UI consumes display data only; legacy storage formats stop here. */
export function chatUpdateTime(
  value: string | undefined,
  legacyLabel?: string,
  now = new Date(),
): ChatUpdateTime {
  const label = chatUpdateLabel(value, now);
  if (label) {
    return {
      label,
      dateTime: value,
      title: `最新更新：${new Date(value!).toLocaleString()}`,
    };
  }
  const days = legacyLabel?.trim().match(/^(\d+)(?:d|天前)$/);
  if (days && Number(days[1]) > 0) {
    const count = Number(days[1]);
    return {
      label: count === 1 ? "昨天" : `${count}天前`,
      title: "旧记录仅保存相对更新时间，尚未恢复准确日期",
    };
  }
  // A stored duration has no reference date; subtracting it from now invents
  // a fresh timestamp every render. Wait for native history to supply one.
  return {
    label: "时间未知",
    title: "旧记录缺少准确更新时间，等待历史记录补全",
  };
}
