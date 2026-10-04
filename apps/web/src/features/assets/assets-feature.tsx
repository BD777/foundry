import {
  BookOpen,
  File as FileIcon,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Monitor,
  Package,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentProjection,
  AssetProjection,
  DeviceProjection,
  ProviderHealth,
  WorkspaceFileEntry,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { AssetSection } from "./asset-section";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DeviceAssetPanel } from "./device-asset-panel";
import { MetaPill } from "../../components/ui/meta-pill";
import { PageSurface } from "../../components/ui/page-surface";
import { SectionLabel } from "../../components/ui/panel";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { Tooltip } from "../../components/ui/tooltip";
import {
  assetDetail,
  assetName,
  assetStatusLabel,
  assetTone,
} from "../../lib/asset-meta";

export type AssetsFeatureEvent =
  { type: "device.logs.requested" } | { type: "data.refresh.requested" };

export interface AssetsFeatureProps {
  embedded?: boolean;
  agents: AgentProjection[];
  assets: AssetProjection[];
  device?: DeviceProjection;
  deviceOnline: boolean;
  files: WorkspaceFileEntry[];
  onEvent?: (event: AssetsFeatureEvent) => void;
  providerHealth: ProviderHealth[];
  runningCount: number;
  skillCount: number;
  workspace: WorkspaceProjection;
}

/** A read-only feature: domain input in, semantic user intent out. */
export function AssetsFeature({
  embedded,
  agents,
  assets,
  device,
  deviceOnline,
  files,
  onEvent,
  providerHealth,
  runningCount,
  skillCount,
  workspace,
}: AssetsFeatureProps) {
  const { t } = useTranslation("assets");
  const worktreeAsset = assets.find((asset) => asset.kind === "worktree_pool");
  const previewAsset = assets.find((asset) => asset.kind === "preview_ports");
  const artifactAsset = assets.find(
    (asset) => asset.kind === "artifact_archive",
  );
  const agentsFile = files.find((file) => file.path === "AGENTS.md");
  const skillsFile = files.find((file) => file.path === ".foundry/skills.yaml");
  const configuredAgentCount = agents.filter(
    (agent) => agent.status === "healthy",
  ).length;
  const deviceLastSeenLabel =
    device?.lastSeenLabel === "online"
      ? t("device.justNow")
      : (device?.lastSeenLabel ?? t("device.never"));
  const deviceLabel = device?.label ?? t("device.noDevice");
  const notReported = t("status.notReported");

  return (
    <PageSurface variant="assets" embedded={embedded}>
      <SectionLabel>
        <Monitor size={13} />
        {t("device.section")}
      </SectionLabel>
      <DeviceAssetPanel
        actions={
          <>
            <Tooltip content={t("device.logs")}>
              <Button
                aria-label={t("device.openLogs")}
                onClick={() => onEvent?.({ type: "device.logs.requested" })}
                size="icon"
                variant="icon"
              >
                <FileText size={15} />
              </Button>
            </Tooltip>
            <Tooltip content={t("device.refresh")}>
              <Button
                aria-label={t("device.refreshDevice")}
                onClick={() => onEvent?.({ type: "data.refresh.requested" })}
                size="icon"
                variant="icon"
              >
                <RefreshCw size={15} />
              </Button>
            </Tooltip>
          </>
        }
        activeWorkers={t("device.workersActive", { count: runningCount })}
        code={t("device.lastConnected", {
          device: deviceLabel,
          when: deviceLastSeenLabel,
        })}
        facts={[
          {
            label: t("device.workdir"),
            mono: true,
            value: workspace.localPath.replace("/Users/you/", "~/"),
          },
          {
            label: t("device.agents"),
            value: t("device.agentsConfigured", {
              configured: configuredAgentCount,
              total: agents.length,
            }),
          },
          { label: t("device.scope"), value: t("device.localDevice") },
        ]}
        identifier={device?.id ?? t("device.noDevice")}
        label={deviceLabel}
        online={deviceOnline}
        tags={
          <>
            {providerHealth.map((provider) => (
              <MetaPill key={provider.provider} size="sm">
                <RuntimeMark runtime={provider.provider} size="sm" />
                {runtimeMeta(provider.provider).label}
              </MetaPill>
            ))}
          </>
        }
      />

      <AssetSection
        icon={<Zap size={13} />}
        rows={[
          {
            end: (
              <Badge
                tone={
                  worktreeAsset ? assetTone(worktreeAsset.status) : "neutral"
                }
              >
                {worktreeAsset
                  ? assetStatusLabel(worktreeAsset.status)
                  : t("status.missing")}
              </Badge>
            ),
            icon: Gauge,
            iconTone: "brass",
            id: "worktree-pool",
            label: worktreeAsset
              ? assetName(worktreeAsset)
              : t("capacity.worktreePool"),
            meta: worktreeAsset ? assetDetail(worktreeAsset) : notReported,
          },
          {
            end: (
              <Badge
                tone={previewAsset ? assetTone(previewAsset.status) : "online"}
              >
                {previewAsset
                  ? assetStatusLabel(previewAsset.status)
                  : t("status.available")}
              </Badge>
            ),
            endWidth: 92,
            icon: Monitor,
            iconTone: "neutral",
            id: "preview-ports",
            label: previewAsset
              ? assetName(previewAsset)
              : t("capacity.previewPorts"),
            meta: previewAsset ? assetDetail(previewAsset) : notReported,
          },
          {
            end: (
              <Badge
                tone={
                  artifactAsset ? assetTone(artifactAsset.status) : "neutral"
                }
              >
                {artifactAsset
                  ? assetStatusLabel(artifactAsset.status)
                  : t("status.missing")}
              </Badge>
            ),
            endWidth: 82,
            icon: FolderOpen,
            iconTone: "green",
            id: "artifact-archive",
            label: artifactAsset
              ? assetName(artifactAsset)
              : t("capacity.artifactArchive"),
            meta: artifactAsset ? assetDetail(artifactAsset) : notReported,
          },
        ]}
        title={t("capacity.title")}
      />

      <AssetSection
        icon={<BookOpen size={13} />}
        rows={[
          {
            end: <Badge tone="online">{t("status.synced")}</Badge>,
            endWidth: 80,
            icon: GitBranch,
            id: "repository",
            label: t("context.workspace"),
            meta: t("context.workspaceMeta", {
              name: workspace.name,
              baseline: workspace.baseline,
            }),
          },
          {
            end: (
              <Badge tone={agentsFile ? "online" : "neutral"}>
                {agentsFile ? t("status.present") : t("status.missing")}
              </Badge>
            ),
            endWidth: 80,
            icon: FileIcon,
            id: "agents",
            label: "AGENTS.md",
            meta: agentsFile?.path ?? notReported,
          },
          {
            end: (
              <Badge dot={false} tone={skillsFile ? "brass" : "neutral"}>
                {skillsFile ? t("status.present") : t("status.missing")}
              </Badge>
            ),
            endWidth: 74,
            icon: Package,
            id: "skills-config",
            label: t("context.skillsConfig"),
            meta: skillsFile
              ? t("context.skillsMeta", {
                  count: skillCount,
                  path: skillsFile.path,
                })
              : notReported,
          },
        ]}
        title={t("context.title")}
      />
    </PageSurface>
  );
}
