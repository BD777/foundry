/**
 * Minimal standard 5-field cron support, shared by the worker (timer
 * snapshot enrichment) and the web UI (live "next fire" display). A cron's
 * fields are wall-clock times in a time zone: the agent process's (an IANA
 * name), or this process's when none is given.
 */

// --- Wall clock in a time zone -------------------------------------------

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat | null {
  let format = zoneFormats.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      format = null;
    }
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/**
 * The IANA zone a `TZ` value names ("America/Toronto", ":Asia/Shanghai",
 * "UTC"); undefined for an empty or unknown one.
 */
export function cronTimeZone(value: string | undefined): string | undefined {
  const zone = value?.trim().replace(/^:/, "");
  return zone && zoneFormat(zone) ? zone : undefined;
}

/** This process's time zone (its TZ, else the system's). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** How far the zone's wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: number, timeZone: string | undefined): number {
  const format = timeZone ? zoneFormat(timeZone) : null;
  if (!format) return -new Date(at).getTimezoneOffset() * 60_000;
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(new Date(at)))
    part[type] = Number(value);
  const wall = Date.UTC(
    part.year ?? 1970,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    (part.hour ?? 0) % 24,
    part.minute ?? 0,
    part.second ?? 0,
  );
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/**
 * The wall-clock time of `at` in the zone, as a Date whose UTC fields hold
 * it (read with getUTC*).
 */
export function cronWallTime(at: Date, timeZone?: string): Date {
  return new Date(at.getTime() + zoneOffsetMs(at.getTime(), timeZone));
}

/** The instant a wall-clock time (UTC fields of `wall`) names in the zone. */
function fromWallTime(wall: number, timeZone: string | undefined): number {
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
}

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
  const dayOfWeek = parseCronField(dowSpec, 0, 7);
  if (dayOfWeek?.delete(7)) dayOfWeek.add(0);
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
 * parsed. Minute-precision, in `timeZone` (this process's when none).
 */
export function nextCronFire(
  expression: string,
  from: Date = new Date(),
  timeZone?: string,
): Date | undefined {
  const parsed = parseCron(expression);
  if (!parsed) {
    return undefined;
  }
  // The scan walks the zone's wall clock (UTC fields), then names the
  // instant once.
  const candidate = cronWallTime(from, timeZone);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  // Minute-level scan, capped at four years to cover rare Feb 29 yearly jobs.
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i += 1) {
    const domMatch = parsed.dayOfMonth.has(candidate.getUTCDate());
    const dowMatch = parsed.dayOfWeek.has(candidate.getUTCDay());
    let dayMatch: boolean;
    if (parsed.dayOfMonthUnused) {
      dayMatch = parsed.dayOfWeekUnused ? true : dowMatch;
    } else {
      dayMatch = parsed.dayOfWeekUnused ? domMatch : domMatch || dowMatch;
    }
    if (
      parsed.minute.has(candidate.getUTCMinutes()) &&
      parsed.hour.has(candidate.getUTCHours()) &&
      parsed.month.has(candidate.getUTCMonth() + 1) &&
      dayMatch
    ) {
      const at = fromWallTime(candidate.getTime(), timeZone);
      // A wall time a daylight-saving change skipped names an earlier
      // instant: the next minute that exists.
      if (at > from.getTime()) return new Date(at);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return undefined;
}

// --- When Claude Code fires a timer ----------------------------------------

/**
 * Claude Code fires a session timer later than its cron says, by an offset
 * fixed by the timer's id, so sessions do not all hit the API on the same
 * minute: a recurring timer up to half its period late (at most 30 minutes),
 * a one-shot timer on :00 or :30 up to 90 s early, and an every-five-minutes
 * timer 15 s before the prompt cache expires. These are Claude Code's
 * defaults (its cron jitter config, 2.1.x); its servers may tune them.
 */
const claudeTimerJitter = {
  recurringFraction: 0.5,
  recurringCapMs: 30 * 60_000,
  oneShotEarlyMs: 90_000,
  oneShotMinuteMod: 30,
  cacheLeadMs: 15_000,
  cacheTtlMs: 5 * 60_000,
};

/** Recurring timers live this long; Claude Code then deletes them. */
export const claudeRecurringTimerMaxAgeMs = 7 * 24 * 60 * 60_000;

function claudeTimerFraction(id: string): number {
  const value = Number.parseInt(id.slice(0, 8), 16) / 4294967296;
  return Number.isFinite(value) ? value : 0;
}

/**
 * When Claude Code fires a recurring timer after it last fired (or was
 * created): the cron's next time plus the timer's offset. Claude fires only
 * while the session is idle, so a busy session runs it later.
 */
export function claudeRecurringFireAfter(
  schedule: string,
  id: string,
  after: Date,
  timeZone?: string,
): Date | undefined {
  const next = nextCronFire(schedule, after, timeZone);
  if (!next) return undefined;
  const offset = recurringOffset(schedule, id, next, timeZone);
  // Kept warm for the prompt cache: a period after the last fire, a little
  // early.
  if (offset === "cache") {
    const following = nextCronFire(schedule, next, timeZone);
    const period = following ? following.getTime() - next.getTime() : 0;
    return new Date(after.getTime() + period - claudeTimerJitter.cacheLeadMs);
  }
  return new Date(next.getTime() + offset);
}

/** A recurring timer's delay after the cron time `slot`, in ms. */
function recurringOffset(
  schedule: string,
  id: string,
  slot: Date,
  timeZone?: string,
): number | "cache" {
  const following = nextCronFire(schedule, slot, timeZone);
  if (!following) return 0;
  const period = following.getTime() - slot.getTime();
  const { cacheLeadMs, cacheTtlMs } = claudeTimerJitter;
  if (
    /^\*\/\d+ \* \* \* \*$/.test(schedule.trim()) &&
    cacheLeadMs < period &&
    period >= cacheTtlMs &&
    period - cacheLeadMs < cacheTtlMs
  ) {
    return "cache";
  }
  return Math.min(
    claudeTimerFraction(id) * claudeTimerJitter.recurringFraction * period,
    claudeTimerJitter.recurringCapMs,
  );
}

/** When Claude Code fires a one-shot timer created at `createdAt`. */
export function claudeOneShotFireAt(
  schedule: string,
  id: string,
  createdAt: Date,
  timeZone?: string,
): Date | undefined {
  const next = nextCronFire(schedule, createdAt, timeZone);
  if (!next) return undefined;
  if (
    cronWallTime(next, timeZone).getUTCMinutes() %
      claudeTimerJitter.oneShotMinuteMod !==
    0
  )
    return next;
  return new Date(
    Math.max(
      next.getTime() -
        claudeTimerFraction(id) * claudeTimerJitter.oneShotEarlyMs,
      createdAt.getTime(),
    ),
  );
}

/** What a reader knows of a recurring timer's last wake. */
export interface ClaudeTimerWake {
  /**
   * When it last fired, or when a Claude process last resumed its session
   * (Claude Code 2.1.291 and later bring the timer back as fired then).
   */
  firedAt?: Date;
}

/**
 * The next time Claude Code fires a timer, seen from `now`. Claude Code
 * fires a recurring timer at its first offset time after it last fired,
 * and only while the session is idle: a time that passed while it was busy
 * fires once it is idle. So with `wake` the answer may be past (it is due
 * and fires when the current turn ends). Without, the first of its cron
 * times whose offset time is still ahead. A one-shot timer that is due but
 * has not fired (its session was busy) answers its due time, which may be
 * past: the exact time its device reported (`nextFireAt` with `timeZone`),
 * else its schedule's first time in the day before `now`. The schedule is
 * read in the timer's `timeZone`.
 */
export function claudeTimerNextFire(
  timer: {
    id: string;
    schedule: string;
    recurring: boolean;
    timeZone?: string;
    nextFireAt?: string;
  },
  now: Date = new Date(),
  wake: ClaudeTimerWake = {},
): Date | undefined {
  const timeZone = cronTimeZone(timer.timeZone);
  if (!timer.recurring) {
    const exact = timeZone ? Date.parse(timer.nextFireAt ?? "") : NaN;
    if (Number.isFinite(exact)) return new Date(exact);
    return claudeOneShotFireAt(
      timer.schedule,
      timer.id,
      new Date(now.getTime() - 24 * 60 * 60_000),
      timeZone,
    );
  }
  const firedAt = validTime(wake.firedAt);
  if (firedAt !== undefined)
    return claudeRecurringFireAfter(
      timer.schedule,
      timer.id,
      new Date(firedAt),
      timeZone,
    );
  // A slot up to the largest offset ago may still be ahead of now.
  let slot = nextCronFire(
    timer.schedule,
    new Date(now.getTime() - claudeTimerJitter.recurringCapMs - 60_000),
    timeZone,
  );
  for (let index = 0; slot && index < 64; index += 1) {
    const offset = recurringOffset(timer.schedule, timer.id, slot, timeZone);
    // A cache-warm timer's offset hangs on its last fire, which is unknown.
    const fire = slot.getTime() + (offset === "cache" ? 0 : offset);
    if (fire > now.getTime()) return new Date(fire);
    slot = nextCronFire(timer.schedule, slot, timeZone);
  }
  return undefined;
}

function validTime(date: Date | undefined): number | undefined {
  const time = date?.getTime();
  return time !== undefined && Number.isFinite(time) ? time : undefined;
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
 * another language is asked for. A one-time timer names its fire time in
 * this process's zone; a recurring one names its cron's wall-clock times,
 * followed by their zone when that is not this process's.
 */
export function humanizeCron(
  expression: string,
  recurring: boolean,
  from: Date = new Date(),
  language: CronLanguage = "zh-CN",
  timeZone?: string,
): string {
  const zone = cronTimeZone(timeZone);
  const label = humanizeCronIn(expression, recurring, from, language, zone);
  return recurring && zone && !sameZone(zone, from)
    ? `${label} (${zone})`
    : label;
}

/** Whether `zone` keeps this process's clock at `at` (and a day around). */
function sameZone(zone: string, at: Date): boolean {
  const day = 24 * 60 * 60_000;
  return [-day, 0, day].every(
    (shift) =>
      zoneOffsetMs(at.getTime() + shift, zone) ===
      zoneOffsetMs(at.getTime() + shift, undefined),
  );
}

function humanizeCronIn(
  expression: string,
  recurring: boolean,
  from: Date,
  language: CronLanguage,
  timeZone: string | undefined,
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
    const next = nextCronFire(expression, from, timeZone);
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
