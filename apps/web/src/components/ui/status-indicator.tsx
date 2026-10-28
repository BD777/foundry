import { CircleAlert, Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Spinner } from "./loading";
import { Popover } from "./popover";

/** How a persistent condition reads; "progress" is work that will finish. */
export type StatusTone = "progress" | "info" | "warning" | "error";

/**
 * A condition of the whole app that holds until it clears (the server
 * cannot be reached, a newer build is deployed). Transient outcomes are
 * toasts; notices about one thing stay next to it (Alert).
 */
export interface StatusItem {
  /** Stable identity, independent of the displayed language. */
  id: string;
  tone: StatusTone;
  /** A word or two for the indicator itself. */
  label: string;
  /** The whole sentence, shown in the details and announced. */
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
}

const severity: Record<StatusTone, number> = {
  progress: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** The most severe condition first; equal ones keep their order. */
export function rankStatusItems(items: readonly StatusItem[]): StatusItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        severity[b.item.tone] - severity[a.item.tone] || a.index - b.index,
    )
    .map(({ item }) => item);
}

function StatusIcon({ tone, size }: { tone: StatusTone; size: number }) {
  if (tone === "progress") return <Spinner size={size} />;
  const Icon = tone === "info" ? Info : CircleAlert;
  return <Icon aria-hidden="true" size={size} />;
}

export interface StatusIndicatorProps {
  items: readonly StatusItem[];
  /** Only the icon, where the label has no room (a collapsed sidebar). */
  iconOnly?: boolean;
  className?: string;
}

/**
 * A compact pill for the app chrome: the most severe condition's label;
 * every condition, with its action, in a popover (the label names the
 * first, the accessible name all of them). It takes the room of what it
 * sits in place of, so the page never moves; while nothing holds it shows
 * nothing. A polite live region announces each condition as it appears.
 */
export function StatusIndicator({
  items,
  iconOnly = false,
  className,
}: StatusIndicatorProps) {
  const { t } = useTranslation("ui");
  const ranked = rankStatusItems(items);
  const top = ranked[0];
  const summary = ranked.map((item) => item.title).join(" · ");
  const triggerLabel = top ? t("status.open", { status: summary }) : "";
  return (
    <>
      <span className="fdy-status-indicator-live" role="status">
        {summary}
      </span>
      {top ? (
        <Popover
          className="fdy-status-indicator-details"
          label={t("status.details")}
          trigger={
            <Button
              aria-label={triggerLabel}
              className={cn("fdy-status-indicator", className)}
              data-icon-only={iconOnly ? "true" : "false"}
              data-tone={top.tone}
              size="sm"
              title={summary}
              variant="bare"
            >
              <StatusIcon size={14} tone={top.tone} />
              {iconOnly ? null : (
                <span className="fdy-status-indicator-label">{top.label}</span>
              )}
            </Button>
          }
        >
          <ul className="fdy-status-indicator-list">
            {ranked.map((item) => (
              <li data-tone={item.tone} key={item.id}>
                <StatusIcon size={15} tone={item.tone} />
                <div>
                  <strong>{item.title}</strong>
                  {item.description ? <p>{item.description}</p> : null}
                  {item.action ? (
                    <Button
                      className="fdy-status-indicator-action"
                      onClick={item.action.onClick}
                      size="sm"
                      variant="secondary"
                    >
                      {item.action.label}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </>
  );
}
