/**
 * Minimal standard 5-field cron support (local time), shared by the worker
 * (timer snapshot enrichment) and the web UI (live "next fire" display).
 */

type CronField = Set<number>;

function parseCronField(
  spec: string,
  min: number,
  max: number,
): CronField | undefined {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!match) {
      return undefined;
    }
    const step = match[3] ? Number(match[3]) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      return undefined;
    }
    let start: number;
    let end: number;
    if (match[1] === "*") {
      start = min;
      end = max;
    } else {
      start = Number(match[1]);
      end = match[2] !== undefined ? Number(match[2]) : start;
    }
    if (start < min || end > max || start > end) {
      return undefined;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}

export interface ParsedCron {
  dayOfMonth: CronField;
  dayOfMonthUnused: boolean;
  dayOfWeek: CronField;
  dayOfWeekUnused: boolean;
  hour: CronField;
  minute: CronField;
  month: CronField;
  raw: string;
}

export function parseCron(expression: string): ParsedCron | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((part) => part === undefined)) {
    return undefined;
  }
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = parseCronField(minuteSpec, 0, 59);
  const hour = parseCronField(hourSpec, 0, 23);
  const dayOfMonth = parseCronField(domSpec, 1, 31);
  const month = parseCronField(monthSpec, 1, 12);
  // Both 0 and 7 mean Sunday in standard cron.
  const dayOfWeek = parseCronField(dowSpec.replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }
  return {
    dayOfMonth,
    dayOfMonthUnused: domSpec === "*",
    dayOfWeek,
    dayOfWeekUnused: dowSpec === "*",
    hour,
    minute,
    month,
    raw: expression.trim(),
  };
}

/**
 * Next strict-after-`from` fire time; undefined when the expression cannot be
 * parsed. Minute-precision, local time.
 */
export function nextCronFire(
  expression: string,
  from: Date = new Date(),
): Date | undefined {
  const parsed = parseCron(expression);
  if (!parsed) {
    return undefined;
  }
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  // Minute-level scan, capped at four years to cover rare Feb 29 yearly jobs.
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i += 1) {
    const domMatch = parsed.dayOfMonth.has(candidate.getDate());
    const dowMatch = parsed.dayOfWeek.has(candidate.getDay());
    let dayMatch: boolean;
    if (parsed.dayOfMonthUnused) {
      dayMatch = parsed.dayOfWeekUnused ? true : dowMatch;
    } else {
      dayMatch = parsed.dayOfWeekUnused ? domMatch : domMatch || dowMatch;
    }
    if (
      parsed.minute.has(candidate.getMinutes()) &&
      parsed.hour.has(candidate.getHours()) &&
      parsed.month.has(candidate.getMonth() + 1) &&
      dayMatch
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

// --- Humanized schedule ---------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, "0");
const formatHM = (hour: number, minute: number): string =>
  `${pad2(hour)}:${pad2(minute)}`;

const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];

function fieldIsEvery(field: CronField, min: number, max: number): boolean {
  return field.size === max - min + 1;
}

/** Compact Chinese description of common 5-field cron expressions. */
export function humanizeCron(
  expression: string,
  recurring: boolean,
  from: Date = new Date(),
): string {
  const parsed = parseCron(expression);
  if (!parsed) {
    return recurring ? `定时 ${expression}` : `单次定时 ${expression}`;
  }
  const minutes = [...parsed.minute].sort((a, b) => a - b);
  const hours = [...parsed.hour].sort((a, b) => a - b);
  const firstMinute = minutes[0];
  const firstHour = hours[0];
  if (firstMinute === undefined || firstHour === undefined) {
    return recurring ? `定时 ${expression}` : `单次定时 ${expression}`;
  }
  const timeLabel =
    hours.length === 1
      ? formatHM(firstHour, firstMinute)
      : hours.map((hour) => formatHM(hour, firstMinute)).join("、");

  // Even minute arithmetic sequences (4,14,24,...) across every hour.
  if (
    fieldIsEvery(parsed.hour, 0, 23) &&
    parsed.dayOfMonthUnused &&
    parsed.dayOfWeekUnused &&
    minutes.length > 1 &&
    minutes[1] !== undefined &&
    minutes.every(
      (value, index) =>
        index === 0 ||
        value - (minutes[index - 1] ?? value) === minutes[1]! - firstMinute,
    )
  ) {
    return `每 ${minutes[1] - firstMinute} 分钟`;
  }
  if (fieldIsEvery(parsed.hour, 0, 23) && minutes.length === 1) {
    return `每小时 ${pad2(firstMinute)} 分`;
  }

  const dayRestricted = !parsed.dayOfMonthUnused || !parsed.dayOfWeekUnused;
  if (!dayRestricted && fieldIsEvery(parsed.month, 1, 12)) {
    if (minutes.length > 1) {
      const slots = hours
        .flatMap((hour) => minutes.map((minute) => formatHM(hour, minute)))
        .join("、");
      return `每天 ${slots}`;
    }
    return `每天 ${timeLabel}`;
  }

  if (
    parsed.dayOfMonthUnused &&
    !parsed.dayOfWeekUnused &&
    fieldIsEvery(parsed.month, 1, 12)
  ) {
    const dows = [...parsed.dayOfWeek].sort((a, b) => a - b);
    if (dows.length === 5 && dows.every((day) => day >= 1 && day <= 5)) {
      return `工作日 ${timeLabel}`;
    }
    const dowLabel = dows
      .map((day) => `周${weekdayNames[day] ?? ""}`)
      .join("、");
    return `${dowLabel} ${timeLabel}`;
  }

  if (
    !parsed.dayOfMonthUnused &&
    parsed.dayOfWeekUnused &&
    fieldIsEvery(parsed.month, 1, 12)
  ) {
    const doms = [...parsed.dayOfMonth].sort((a, b) => a - b);
    return `每月 ${doms.join("、")} 日 ${timeLabel}`;
  }

  if (!parsed.dayOfMonthUnused && parsed.dayOfWeekUnused) {
    const doms = [...parsed.dayOfMonth].sort((a, b) => a - b);
    const months = [...parsed.month].sort((a, b) => a - b);
    return `每年 ${months.join("、")} 月 ${doms.join("、")} 日 ${timeLabel}`;
  }

  if (!recurring) {
    const next = nextCronFire(expression, from);
    return next
      ? `单次 · ${next.toLocaleString("zh-CN", { hour12: false })}`
      : `单次定时 ${expression}`;
  }
  return `定时 ${expression}`;
}
