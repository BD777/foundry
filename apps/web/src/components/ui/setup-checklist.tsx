import { cva } from "class-variance-authority";
import { Check, Circle, Info, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Spinner } from "./loading";

/**
 * Where one part of a setup stands. Each state has its own marker and an
 * accessible name, so it never rests on colour alone.
 */
export type SetupChecklistState =
  "done" | "needed" | "running" | "failed" | "info";

export interface SetupChecklistProps {
  /** Names the list for assistive technology. */
  label: string;
  className?: string;
  /**
   * "panel" (default) draws the list's own surface; "none" leaves it to a
   * surrounding row or panel, so steps inside a list row add no card.
   */
  surface?: "panel" | "none";
  children: ReactNode;
}

const listVariants = cva(
  "group/checklist m-0 grid list-none p-0 @container/setup-checklist",
  {
    variants: {
      surface: {
        panel: "rounded-lg bg-panel shadow-card",
        /** Inside a surface that owns the boundary: no box, items start flush. */
        none: "",
      },
    },
  },
);

const markerVariants = cva(
  "mt-px inline-flex size-5 items-center justify-center rounded-full border",
  {
    variants: {
      // "needed" (not started yet) keeps the neutral grey ring: only a
      // failure takes a warning colour.
      state: {
        done: "border-success-border bg-success-surface text-success-text",
        needed: "border-line-strong bg-panel-soft text-ink-faint",
        running: "border-line-strong bg-panel-soft text-ink",
        failed: "border-error-border bg-error-surface text-error-text",
        info: "border-line-strong bg-panel-soft text-ink-faint",
      },
    },
  },
);

/** A flat list of setup items: one surface, rows divided by a rule. */
export function SetupChecklist({
  label,
  className,
  surface = "panel",
  children,
}: SetupChecklistProps) {
  return (
    <ul
      aria-label={label}
      className={cn(listVariants({ surface }), className)}
      data-surface={surface}
    >
      {children}
    </ul>
  );
}

export interface SetupChecklistItemProps {
  state: SetupChecklistState;
  title: ReactNode;
  /** What the state means here, in words (the marker only repeats it). */
  detail?: ReactNode;
  /** Shown before the title, e.g. a runtime mark. */
  prefix?: ReactNode;
  /** The item's one action: a single Button, or nothing. */
  action?: ReactNode;
  /** Output to read on request, behind a disclosure. */
  log?: string;
  /** The disclosure's label; defaults to "Details". */
  logLabel?: string;
}

const markers: Record<SetupChecklistState, ReactNode> = {
  done: <Check size={13} />,
  needed: <Circle size={11} />,
  running: <Spinner size={13} />,
  failed: <X size={13} />,
  info: <Info size={13} />,
};

export function SetupChecklistItem({
  state,
  title,
  detail,
  prefix,
  action,
  log,
  logLabel,
}: SetupChecklistItemProps) {
  const { t } = useTranslation("ui");
  return (
    <li
      aria-busy={state === "running" ? true : undefined}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-line group-data-[surface=none]/checklist:px-0 group-data-[surface=none]/checklist:py-1.5 @max-[420px]/setup-checklist:grid-cols-[auto_minmax(0,1fr)]"
      data-state={state}
    >
      <span
        aria-label={t(`setupChecklist.states.${state}`)}
        className={markerVariants({ state })}
        role="img"
      >
        {markers[state]}
      </span>
      <div className="grid min-w-0 gap-[3px]">
        <span className="inline-flex min-w-0 items-center gap-[7px] text-sm leading-[1.4] text-ink">
          {prefix}
          <strong>{title}</strong>
        </span>
        {detail ? (
          <div
            className={cn(
              "grid gap-1.5 text-xs leading-[1.45] [overflow-wrap:anywhere]",
              state === "failed" ? "text-error-text" : "text-ink-muted",
            )}
          >
            {detail}
          </div>
        ) : null}
        {log?.trim() ? (
          <details>
            <summary className="w-fit cursor-pointer text-xs text-ink-muted focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--fdy-control-focus)">
              {logLabel ?? t("setupChecklist.details")}
            </summary>
            <pre className="mx-0 mt-1.5 mb-0 max-h-[220px] overflow-auto rounded-sm bg-panel-soft px-2.5 py-2 text-2xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {log}
            </pre>
          </details>
        ) : null}
      </div>
      {action ? (
        <span className="inline-flex self-center @max-[420px]/setup-checklist:col-start-2 @max-[420px]/setup-checklist:justify-self-start">
          {action}
        </span>
      ) : null}
    </li>
  );
}
