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
 * reported.
 */
export function assetDetail(asset: AssetProjection): string {
  const detail = asset.detail.trim();
  if (detail === "add .foundry/preview.json")
    return i18n.t("assets:capacity.previewSetup");
  if (
    (asset.kind === "worktree_pool" || asset.kind === "artifact_archive") &&
    (detail.startsWith("/") || detail.startsWith("~"))
  )
    return i18n.t(
      asset.kind === "worktree_pool"
        ? "assets:capacity.worktreesAt"
        : "assets:capacity.evidenceAt",
      { path: detail },
    );
  return detail;
}
