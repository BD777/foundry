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
import { Tooltip } from "../ui/tooltip";

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
        className="fdy-work-state-icon"
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
        <span className="fdy-work-state-mark" aria-hidden="true">
          {Mark ? (
            <Mark size={8} strokeWidth={2.5} />
          ) : (
            <span className="fdy-work-state-point" />
          )}
        </span>
      </span>
    </Tooltip>
  );
}
