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

export type CronLanguage = "en" | "zh-CN";

interface CronWording {
  daily: (slots: string) => string;
  everyMinutes: (step: number) => string;
  hourly: (minute: string) => string;
  monthDay: (days: string, time: string) => string;
  monthName: (month: number) => string;
  once: (next: Date) => string;
  oneTimeUnparsed: (expression: string) => string;
  recurringUnparsed: (expression: string) => string;
  separator: string;
  weekday: (day: number) => string;
  weekdays: (time: string) => string;
  yearly: (months: string, days: string, time: string) => string;
}

const zhWeekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
const enWeekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const enMonthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const cronWording: Record<CronLanguage, CronWording> = {
  en: {
    daily: (slots) => `Daily ${slots}`,
    everyMinutes: (step) => `Every ${step} minutes`,
    hourly: (minute) => `Hourly at :${minute}`,
    monthDay: (days, time) => `Monthly on day ${days}, ${time}`,
    monthName: (month) => enMonthNames[month - 1] ?? String(month),
    once: (next) =>
      `Once · ${next.toLocaleString("en-US", { hourCycle: "h23" })}`,
    oneTimeUnparsed: (expression) => `One-time ${expression}`,
    recurringUnparsed: (expression) => `Scheduled ${expression}`,
    separator: ", ",
    weekday: (day) => enWeekdayNames[day] ?? "",
    weekdays: (time) => `Weekdays ${time}`,
    yearly: (months, days, time) =>
      `Yearly in ${months} on day ${days}, ${time}`,
  },
  "zh-CN": {
    daily: (slots) => `每天 ${slots}`,
    everyMinutes: (step) => `每 ${step} 分钟`,
    hourly: (minute) => `每小时 ${minute} 分`,
    monthDay: (days, time) => `每月 ${days} 日 ${time}`,
    monthName: (month) => String(month),
    once: (next) => `单次 · ${next.toLocaleString("zh-CN", { hour12: false })}`,
    oneTimeUnparsed: (expression) => `单次定时 ${expression}`,
    recurringUnparsed: (expression) => `定时 ${expression}`,
    separator: "、",
    weekday: (day) => `周${zhWeekdayNames[day] ?? ""}`,
    weekdays: (time) => `工作日 ${time}`,
    yearly: (months, days, time) => `每年 ${months} 月 ${days} 日 ${time}`,
  },
};

function fieldIsEvery(field: CronField, min: number, max: number): boolean {
  return field.size === max - min + 1;
}

/**
 * Compact description of common 5-field cron expressions, in Chinese unless
 * another language is asked for.
 */
export function humanizeCron(
  expression: string,
  recurring: boolean,
  from: Date = new Date(),
  language: CronLanguage = "zh-CN",
): string {
  const wording = cronWording[language];
  const unparsed = () =>
    recurring
      ? wording.recurringUnparsed(expression)
      : wording.oneTimeUnparsed(expression);
  const parsed = parseCron(expression);
  if (!parsed) {
    return unparsed();
  }
  // A one-time timer (a wake-up) names its fire time; its cron fields only
  // encode that time and would otherwise read as "Daily" or "Yearly".
  if (!recurring) {
    const next = nextCronFire(expression, from);
    return next ? wording.once(next) : unparsed();
  }
  const minutes = [...parsed.minute].sort((a, b) => a - b);
  const hours = [...parsed.hour].sort((a, b) => a - b);
  const firstMinute = minutes[0];
  const firstHour = hours[0];
  if (firstMinute === undefined || firstHour === undefined) {
    return unparsed();
  }
  const timeLabel =
    hours.length === 1
      ? formatHM(firstHour, firstMinute)
      : hours
          .map((hour) => formatHM(hour, firstMinute))
          .join(wording.separator);

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
    return wording.everyMinutes(minutes[1] - firstMinute);
  }
  if (fieldIsEvery(parsed.hour, 0, 23) && minutes.length === 1) {
    return wording.hourly(pad2(firstMinute));
  }

  const dayRestricted = !parsed.dayOfMonthUnused || !parsed.dayOfWeekUnused;
  if (!dayRestricted && fieldIsEvery(parsed.month, 1, 12)) {
    if (minutes.length > 1) {
      const slots = hours
        .flatMap((hour) => minutes.map((minute) => formatHM(hour, minute)))
        .join(wording.separator);
      return wording.daily(slots);
    }
    return wording.daily(timeLabel);
  }

  if (
    parsed.dayOfMonthUnused &&
    !parsed.dayOfWeekUnused &&
    fieldIsEvery(parsed.month, 1, 12)
  ) {
    const dows = [...parsed.dayOfWeek].sort((a, b) => a - b);
    if (dows.length === 5 && dows.every((day) => day >= 1 && day <= 5)) {
      return wording.weekdays(timeLabel);
    }
    const dowLabel = dows.map(wording.weekday).join(wording.separator);
    return `${dowLabel} ${timeLabel}`;
  }

  if (
    !parsed.dayOfMonthUnused &&
    parsed.dayOfWeekUnused &&
    fieldIsEvery(parsed.month, 1, 12)
  ) {
    const doms = [...parsed.dayOfMonth].sort((a, b) => a - b);
    return wording.monthDay(doms.join(wording.separator), timeLabel);
  }

  if (!parsed.dayOfMonthUnused && parsed.dayOfWeekUnused) {
    const doms = [...parsed.dayOfMonth].sort((a, b) => a - b);
    const months = [...parsed.month].sort((a, b) => a - b);
    return wording.yearly(
      months.map(wording.monthName).join(wording.separator),
      doms.join(wording.separator),
      timeLabel,
    );
  }

  return wording.recurringUnparsed(expression);
}
