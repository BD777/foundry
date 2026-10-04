import {
  FolderOpen,
  GitBranch,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { AssetProjection } from "@bd777/foundry-protocol";
import type { BadgeProps } from "../components/ui/badge";
import { i18n } from "../i18n";

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
  return i18n.t(`assets:status.${status}`);
}

const assetNameKeys = {
  worktree_pool: "assets:capacity.worktreePool",
  preview_ports: "assets:capacity.previewPorts",
  artifact_archive: "assets:capacity.artifactArchive",
} as const;

/** The asset's name in the viewer's language; the worker's name is data. */
export function assetName(asset: AssetProjection): string {
  return asset.kind in assetNameKeys
    ? i18n.t(assetNameKeys[asset.kind as keyof typeof assetNameKeys])
    : asset.name;
}

/**
 * The worker describes each asset in fixed English or as a device path; the
 * known forms are shown in the viewer's language and anything else as
 * reported. Workers before 0.5.4 named `.foundry/assets.yaml`, a file that
 * configured nothing, so only the explanation is shown for them.
 */
export function assetDetail(asset: AssetProjection): string {
  const detail = asset.detail.trim();
  if (detail === "copy preview.example.json to preview.json")
    return i18n.t("assets:capacity.previewSetup");
  if (asset.kind === "worktree_pool" || asset.kind === "artifact_archive") {
    const key =
      asset.kind === "worktree_pool"
        ? "assets:capacity.worktrees"
        : "assets:capacity.evidence";
    if (detail.startsWith("/") || detail.startsWith("~"))
      return i18n.t(`${key}At`, { path: detail });
    if (detail.includes(".foundry/assets.yaml")) return i18n.t(key);
  }
  return detail;
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
