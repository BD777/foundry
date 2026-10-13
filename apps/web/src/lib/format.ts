import { i18n } from "../i18n";

const unitBytes = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;

export interface ByteFormat {
  /** Decimals in KB (default 0). */
  kbDigits?: number;
  /** Decimals in MB (default 1); "adaptive" keeps one only below 10 MB. */
  mbDigits?: number | "adaptive";
  /** Drop trailing zeros: "2 KB", not "2.0 KB". */
  trimZeros?: boolean;
  /** Show small sizes as at least "1 KB", never in bytes. */
  atLeastKB?: boolean;
}

/** "512 B", "3 KB", "1.5 MB": a byte count in binary units. */
export function formatBytes(bytes: number, format: ByteFormat = {}): string {
  const {
    kbDigits = 0,
    mbDigits = 1,
    trimZeros = false,
    atLeastKB = false,
  } = format;
  const fixed = (value: number, digits: number) => {
    const text = value.toFixed(digits);
    return trimZeros ? String(Number(text)) : text;
  };
  if (bytes < unitBytes.KB && !atLeastKB) return `${bytes} B`;
  if (bytes < unitBytes.MB)
    return `${fixed(Math.max(atLeastKB ? 1 : 0, bytes / unitBytes.KB), kbDigits)} KB`;
  const mb = bytes / unitBytes.MB;
  const digits = mbDigits === "adaptive" ? (mb < 10 ? 1 : 0) : mbDigits;
  return `${fixed(mb, digits)} MB`;
}

/** A byte count as a localized number of one unit, without the unit. */
export function bytesIn(
  bytes: number,
  unit: keyof typeof unitBytes,
  digits: Pick<
    Intl.NumberFormatOptions,
    "minimumFractionDigits" | "maximumFractionDigits"
  >,
): string {
  return (bytes / unitBytes[unit]).toLocaleString(i18n.language, digits);
}

const wholeSeconds = (ms: number, least: number) =>
  Math.max(least, Math.round(ms / 1000));

/** "1h 3m", "1m 12s", "34s" in the interface language; at least a second. */
export function formatDuration(ms: number): string {
  const totalSeconds = wholeSeconds(ms, 1);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return i18n.t("conversation:usage.hours", { hours, minutes });
  if (minutes > 0)
    return i18n.t("conversation:usage.minutes", { minutes, seconds });
  return i18n.t("conversation:usage.seconds", { seconds });
}

/** "2m 05s", "0s": a run's elapsed time, in minutes and padded seconds. */
export function formatRunDuration(ms: number): string {
  const totalSeconds = wholeSeconds(ms, 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return i18n.t("runs:duration.minutes", {
      minutes,
      seconds: seconds.toString().padStart(2, "0"),
    });
  }
  return i18n.t("runs:duration.seconds", { seconds });
}

/** "75m 3s", "8s": minutes and seconds, at least a second, not localized. */
export function formatCompactDuration(ms: number): string {
  const totalSeconds = wholeSeconds(ms, 1);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
