import {
  FolderOpen,
  GitBranch,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { AssetProjection } from "@foundry/protocol";
import type { BadgeProps } from "../components/ui/badge";

export type BadgeTone = NonNullable<BadgeProps["tone"]>;

export function assetTone(status: AssetProjection["status"]): BadgeTone {
  if (status === "available") {
    return "online";
  }
  if (status === "blocked" || status === "missing") {
    return "error";
  }
  return "warn";
}

export function assetStatusLabel(status: AssetProjection["status"]): string {
  const labels: Record<AssetProjection["status"], string> = {
    available: "Available",
    blocked: "Blocked",
    leased: "Leased",
    missing: "Missing",
  };

  return labels[status];
}

export function assetIcon(asset: AssetProjection): LucideIcon {
  if (asset.kind === "worktree_pool") {
    return GitBranch;
  }
  if (asset.kind === "preview_ports") {
    return Terminal;
  }
  if (asset.kind === "provider_auth") {
    return ShieldCheck;
  }
  return FolderOpen;
}
