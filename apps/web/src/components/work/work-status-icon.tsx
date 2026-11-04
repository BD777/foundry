import {
  Bot,
  Check,
  Clock,
  HelpCircle,
  Hourglass,
  Pause,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { SessionWork } from "@bd777/foundry-protocol";
import { cn } from "../../lib/cn";
import { Tooltip } from "../ui/tooltip";

const iconClass =
  "relative inline-flex size-5 flex-none items-center justify-center rounded-xs text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-(color:--fdy-accent)";
const pointClass = "size-1.5 rounded-full border border-current";

const statusColor: Record<string, string> = {
  running: "text-info-text",
  idle: "text-info-text",
  completed: "text-success-text",
  failed: "text-error-text",
  paused: "text-warning-text",
  suspended: "text-warning-text",
  pending: "text-warning-text",
};

/** Keeps the work type legible while its color and small static mark show state. */
export function WorkStatusIcon({
  kind,
  status,
  label,
}: {
  kind: SessionWork["kind"];
  status: string;
  label: string;
}) {
  const Icon = kind === "schedule" ? Clock : kind === "agent" ? Bot : Terminal;
  const Mark =
    status === "completed"
      ? Check
      : status === "failed"
        ? X
        : status === "paused" || status === "suspended"
          ? Pause
          : status === "pending"
            ? Hourglass
            : status === "stopped"
              ? Square
              : status === "unknown"
                ? HelpCircle
                : undefined;
  return (
    <Tooltip content={label}>
      <span
        className={cn(iconClass, statusColor[status])}
        data-status={status}
        data-kind={kind}
        tabIndex={0}
        role="img"
        aria-label={label}
      >
        <Icon
          aria-hidden="true"
          size={18}
          strokeWidth={status === "running" ? 2.25 : 1.75}
        />
        <span
          className="absolute -right-px -bottom-px inline-flex size-[9px] items-center justify-center rounded-xs bg-panel"
          aria-hidden="true"
        >
          {Mark ? (
            <Mark size={8} strokeWidth={2.5} />
          ) : (
            <span
              className={cn(pointClass, status === "running" && "bg-current")}
            />
          )}
        </span>
      </span>
    </Tooltip>
  );
}
