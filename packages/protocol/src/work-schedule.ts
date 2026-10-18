import { parseCron } from "./cron.js";

/** Next UTC instant matching a cron in its declared IANA zone. Calendar-day
 * stepping avoids a minute-by-minute scan and handles DST gaps and folds. */
export function nextZonedWorkFire(
  expression: string,
  timeZone: string,
  after: Date,
): Date | undefined {
  const cron = parseCron(expression);
  if (!cron || !Number.isFinite(after.getTime())) return undefined;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wall = (instant: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
  };
  const startWall = wall(after.getTime());
  const start = new Date(startWall);
  start.setUTCHours(0, 0, 0, 0);
  const hours = [...cron.hour].sort((a, b) => a - b),
    minutes = [...cron.minute].sort((a, b) => a - b);
  for (let day = 0; day < 4 * 366; day++) {
    const date = new Date(start.getTime() + day * 86400000);
    const dom = cron.dayOfMonth.has(date.getUTCDate()),
      dow = cron.dayOfWeek.has(date.getUTCDay());
    const matchDay = cron.dayOfMonthUnused
      ? cron.dayOfWeekUnused || dow
      : cron.dayOfWeekUnused
        ? dom
        : dom || dow;
    if (!matchDay || !cron.month.has(date.getUTCMonth() + 1)) continue;
    const offsets = new Set(
      [-86400000, 0, 86400000].map((shift) => {
        const instant = date.getTime() + shift;
        return instant - wall(instant);
      }),
    );
    let earliest = Infinity;
    for (const hour of hours)
      for (const minute of minutes) {
        const target = date.getTime() + hour * 3600000 + minute * 60000;
        if (day === 0 && target < startWall - 86400000) continue;
        for (const offset of offsets) {
          const instant = target + offset;
          if (
            instant > after.getTime() &&
            instant < earliest &&
            wall(instant) === target
          )
            earliest = instant;
        }
      }
    if (Number.isFinite(earliest)) return new Date(earliest);
  }
  return undefined;
}
