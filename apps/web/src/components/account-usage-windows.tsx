import type { ReactNode } from "react";
import type { NativeAccountUsage } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { ProgressMeter } from "./ui/progress-meter";
import { cn } from "../lib/cn";

export function AccountUsageWindows({
  windows,
  compact = false,
  footer,
}: {
  windows: readonly NativeAccountUsage[];
  /** A denser sidebar layout; the account page keeps its default spacing. */
  compact?: boolean;
  /** Observation-level detail beside the last visible window’s reset time. */
  footer?: ReactNode;
}) {
  const { t, i18n } = useTranslation("profiles");
  return (
    <div
      className={cn("grid min-w-0 gap-3", compact && "gap-2")}
      data-compact={compact || undefined}
    >
      {windows.map((window, index) => {
        const minutes = window.windowMinutes;
        const duration =
          minutes && Number.isFinite(minutes) && minutes > 0
            ? minutes % 1440 === 0
              ? t("inspection.windowDays", { days: minutes / 1440 })
              : minutes % 60 === 0
                ? t("inspection.windowHours", { hours: minutes / 60 })
                : t("quota.windowMinutes", { minutes })
            : t("inspection.usageWindow");
        const label =
          window.id === "extra_usage"
            ? t("quota.extraUsage")
            : window.label
              ? `${window.label} · ${duration}`
              : duration;
        const known =
          typeof window.usedPercent === "number" &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 0 &&
          window.usedPercent <= 100;
        const percent = known ? window.usedPercent! : undefined;
        const reset = window.resetsAt
          ? new Date(window.resetsAt * 1000)
          : undefined;
        return (
          <div
            className={cn("grid min-w-0 gap-[5px]", compact && "gap-1")}
            key={window.id ?? index}
          >
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="wrap-anywhere">{label}</span>
              <strong className="shrink-0 font-medium tabular-nums">
                {known
                  ? t("inspection.used", {
                      percent: new Intl.NumberFormat(i18n.language, {
                        maximumFractionDigits: 1,
                      }).format(percent!),
                    })
                  : t("quota.unknown")}
              </strong>
            </div>
            {known ? (
              <ProgressMeter
                aria-label={`${label}: ${t("inspection.usageLabel")}`}
                max={100}
                value={percent}
              />
            ) : null}
            {(reset && Number.isFinite(reset.getTime())) ||
            (footer && index === windows.length - 1) ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-0.5 [&>small]:text-2xs [&>small]:text-ink-muted">
                {reset && Number.isFinite(reset.getTime()) ? (
                  <small>
                    {t("inspection.resets", {
                      time: reset.toLocaleString(i18n.language, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })}
                  </small>
                ) : null}
                {index === windows.length - 1 ? footer : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
