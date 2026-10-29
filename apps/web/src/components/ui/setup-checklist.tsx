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
  children: ReactNode;
}

/** A flat list of setup items: one surface, rows divided by a rule. */
export function SetupChecklist({
  label,
  className,
  children,
}: SetupChecklistProps) {
  return (
    <ul aria-label={label} className={cn("fdy-setup-checklist", className)}>
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
      className="fdy-setup-checklist-item"
      data-state={state}
    >
      <span
        aria-label={t(`setupChecklist.states.${state}`)}
        className="fdy-setup-checklist-marker"
        role="img"
      >
        {markers[state]}
      </span>
      <div className="fdy-setup-checklist-body">
        <span className="fdy-setup-checklist-title">
          {prefix}
          <strong>{title}</strong>
        </span>
        {detail ? (
          <div className="fdy-setup-checklist-detail">{detail}</div>
        ) : null}
        {log?.trim() ? (
          <details className="fdy-setup-checklist-log">
            <summary>{logLabel ?? t("setupChecklist.details")}</summary>
            <pre>{log}</pre>
          </details>
        ) : null}
      </div>
      {action ? (
        <span className="fdy-setup-checklist-action">{action}</span>
      ) : null}
    </li>
  );
}
