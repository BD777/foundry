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
  /** Show sizes from 1 GB in GB, with one decimal (default: MB). */
  gb?: boolean;
}

/** "512 B", "3 KB", "1.5 MB": a byte count in binary units. */
export function formatBytes(bytes: number, format: ByteFormat = {}): string {
  const {
    kbDigits = 0,
    mbDigits = 1,
    trimZeros = false,
    atLeastKB = false,
    gb = false,
  } = format;
  const fixed = (value: number, digits: number) => {
    const text = value.toFixed(digits);
    return trimZeros ? String(Number(text)) : text;
  };
  if (bytes < unitBytes.KB && !atLeastKB) return `${bytes} B`;
  if (bytes < unitBytes.MB)
    return `${fixed(Math.max(atLeastKB ? 1 : 0, bytes / unitBytes.KB), kbDigits)} KB`;
  if (gb && bytes >= unitBytes.GB)
    return `${fixed(bytes / unitBytes.GB, 1)} GB`;
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

/** A usage breakdown keeps an exact zero instead of rounding it up. */
export function formatUsageDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped === 0
    ? i18n.t("conversation:usage.zeroSeconds")
    : formatDuration(clamped);
}

/** "75m 3s", "8s": minutes and seconds, at least a second, not localized. */
export function formatCompactDuration(ms: number): string {
  const totalSeconds = wholeSeconds(ms, 1);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Output-token speed over a supplied interval; short or tiny samples are noise. */
export function outputTokensPerSecond(
  outputTokens: number,
  elapsedMs: number,
): number | undefined {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(elapsedMs) ||
    outputTokens < 20 ||
    elapsedMs < 200
  ) {
    return undefined;
  }
  return outputTokens / (elapsedMs / 1000);
}

/** Estimated request times are too noisy to show when they imply a local spike. */
export function estimatedOutputTimingReliable(
  outputTokens: number,
  elapsedMs: number,
): boolean {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 1000
  )
    return false;
  return outputTokens / (elapsedMs / 1000) <= 1000;
}

/** "85 tok/s", or one decimal below 10 tok/s; `≈` marks an estimate. */
export function formatOutputSpeed(
  outputTokens: number,
  elapsedMs: number,
  estimated = false,
): string | undefined {
  if (estimated && !estimatedOutputTimingReliable(outputTokens, elapsedMs))
    return undefined;
  const speed = outputTokensPerSecond(outputTokens, elapsedMs);
  if (speed === undefined) return undefined;
  const roundedToTenth = Math.round(speed * 10) / 10;
  const digits = roundedToTenth < 10 ? 1 : 0;
  const value = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(speed);
  const formatted = i18n.t("conversation:usage.outputSpeedValue", { value });
  return estimated ? `≈${formatted}` : formatted;
}

/** "850ms" below a second, "1.0s" from a second; `≈` marks an estimate. */
export function formatTimeToFirstToken(
  ms: number,
  estimated = false,
): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const roundedMs = Math.round(ms);
  const value =
    roundedMs < 1000
      ? new Intl.NumberFormat(i18n.language, {
          maximumFractionDigits: 0,
        }).format(roundedMs)
      : new Intl.NumberFormat(i18n.language, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(roundedMs / 1000);
  const formatted =
    roundedMs < 1000
      ? i18n.t("conversation:usage.milliseconds", { value })
      : i18n.t("conversation:usage.seconds", { seconds: value });
  return estimated ? `≈${formatted}` : formatted;
}
