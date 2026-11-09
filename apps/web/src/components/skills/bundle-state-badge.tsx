import {
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Loader2,
  MinusCircle,
  PauseCircle,
  TriangleAlert,
  Undo2,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  SkillBundleCheckStep,
  SkillBundleRollout,
  SkillBundleRolloutDevice,
} from "@bd777/foundry-protocol";
import type { BundleDeviceStatus } from "../../lib/bundle-versions";
import { Badge, type BadgeProps } from "../ui/badge";

/** How a bundle state looks: an icon and a tone, always beside its words. */
export type BundleStateLook =
  | "ok"
  | "failed"
  | "working"
  | "waiting"
  | "offline"
  | "warning"
  | "update"
  | "unchecked"
  | "undone"
  | "skipped"
  | "paused";

const looks: Record<
  BundleStateLook,
  { icon: LucideIcon; tone: BadgeProps["tone"]; spin?: boolean }
> = {
  ok: { icon: CheckCircle2, tone: "online" },
  failed: { icon: XCircle, tone: "error" },
  working: { icon: Loader2, tone: "slate", spin: true },
  waiting: { icon: Clock, tone: "neutral" },
  offline: { icon: WifiOff, tone: "neutral" },
  warning: { icon: TriangleAlert, tone: "warn" },
  update: { icon: ArrowUpCircle, tone: "slate" },
  unchecked: { icon: HelpCircle, tone: "neutral" },
  undone: { icon: Undo2, tone: "warn" },
  skipped: { icon: MinusCircle, tone: "neutral" },
  paused: { icon: PauseCircle, tone: "warn" },
};

export const deviceStatusLook: Record<BundleDeviceStatus, BundleStateLook> = {
  consistent: "ok",
  unchecked: "unchecked",
  "update-available": "update",
  waiting: "waiting",
  mismatch: "warning",
};

export const rolloutDeviceLook: Record<
  SkillBundleRolloutDevice["state"],
  BundleStateLook
> = {
  pending: "waiting",
  installing: "working",
  checking: "working",
  updated: "ok",
  failed: "failed",
  offline: "offline",
  rolled_back: "undone",
};

export const rolloutLook: Record<SkillBundleRollout["state"], BundleStateLook> =
  {
    waiting: "waiting",
    canary: "working",
    rolling: "working",
    done: "ok",
    failed: "failed",
    rolled_back: "undone",
  };

export const checkStepLook: Record<
  SkillBundleCheckStep["state"],
  BundleStateLook
> = {
  passed: "ok",
  failed: "failed",
  skipped: "skipped",
};

/** A bundle, rollout or device state in words with its icon. */
export function BundleStateBadge({
  look,
  children,
  className,
}: {
  look: BundleStateLook;
  children: string;
  className?: string;
}) {
  const { icon: Icon, tone, spin } = looks[look];
  return (
    <Badge className={className} dot={false} tone={tone}>
      <Icon
        aria-hidden="true"
        className={
          spin
            ? "flex-none animate-spinner motion-reduce:animate-none"
            : "flex-none"
        }
        size={12}
      />
      {children}
    </Badge>
  );
}
