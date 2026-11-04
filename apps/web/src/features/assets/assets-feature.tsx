import {
  BookOpen,
  File as FileIcon,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Monitor,
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
import { Button } from "../../components/ui/button";
import { DeviceAssetPanel } from "./device-asset-panel";
import { MetaPill } from "../../components/ui/meta-pill";
import { PageSurface } from "../../components/ui/page-surface";
import { SectionLabel } from "../../components/ui/panel";
import {
  RuntimeMark,
  runtimeMeta,
} from "../../components/agent-runtime/runtime-mark";
import { Tooltip } from "../../components/ui/tooltip";
import {
  assetDetail,
  assetName,
  assetStatusLabel,
  assetTone,
} from "../../lib/asset-meta";

const sectionSpacing = "mb-5.5";
const lastSectionSpacing = "mb-5.5 last:mb-0";

/** A square icon button of the device panel: a hairline outline, no fill. */
const deviceActionButton =
  "size-[30px] rounded-sm border border-line bg-panel text-ink-faint hover:border-line-strong hover:bg-panel-soft max-[860px]:size-7";

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
  workspace,
}: AssetsFeatureProps) {
  const { t } = useTranslation("assets");
  const worktreeAsset = assets.find((asset) => asset.kind === "worktree_pool");
  const previewAsset = assets.find((asset) => asset.kind === "preview_ports");
  const artifactAsset = assets.find(
    (asset) => asset.kind === "artifact_archive",
  );
  const agentsFile = files.find((file) => file.path === "AGENTS.md");
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
    <PageSurface embedded={embedded} variant="assets">
      <SectionLabel className={embedded ? undefined : "mb-[9px]"}>
        <Monitor size={13} />
        {t("device.section")}
      </SectionLabel>
      <DeviceAssetPanel
        className={embedded ? undefined : sectionSpacing}
        actions={
          <>
            <Tooltip content={t("device.logs")}>
              <Button
                aria-label={t("device.openLogs")}
                onClick={() => onEvent?.({ type: "device.logs.requested" })}
                className={deviceActionButton}
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
                className={deviceActionButton}
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
              <MetaPill
                className="font-semibold text-ink-muted"
                key={provider.provider}
                size="sm"
              >
                <RuntimeMark runtime={provider.provider} size="sm" />
                {runtimeMeta(provider.provider).label}
              </MetaPill>
            ))}
          </>
        }
      />

      <AssetSection
        className={embedded ? undefined : sectionSpacing}
        icon={<Zap size={13} />}
        rows={[
          {
            icon: Gauge,
            iconTone: "brass",
            id: "worktree-pool",
            label: worktreeAsset
              ? assetName(worktreeAsset)
              : t("capacity.worktreePool"),
            meta: worktreeAsset ? assetDetail(worktreeAsset) : notReported,
            status: {
              label: worktreeAsset
                ? assetStatusLabel(worktreeAsset.status)
                : t("status.missing"),
              tone: worktreeAsset ? assetTone(worktreeAsset.status) : "neutral",
            },
          },
          {
            icon: Monitor,
            iconTone: "neutral",
            id: "preview-ports",
            label: previewAsset
              ? assetName(previewAsset)
              : t("capacity.previewPorts"),
            meta: previewAsset ? assetDetail(previewAsset) : notReported,
            status: {
              label: previewAsset
                ? assetStatusLabel(previewAsset.status)
                : t("status.available"),
              tone: previewAsset ? assetTone(previewAsset.status) : "online",
              width: 92,
            },
          },
          {
            icon: FolderOpen,
            iconTone: "green",
            id: "artifact-archive",
            label: artifactAsset
              ? assetName(artifactAsset)
              : t("capacity.artifactArchive"),
            meta: artifactAsset ? assetDetail(artifactAsset) : notReported,
            status: {
              label: artifactAsset
                ? assetStatusLabel(artifactAsset.status)
                : t("status.missing"),
              tone: artifactAsset ? assetTone(artifactAsset.status) : "neutral",
              width: 82,
            },
          },
        ]}
        title={t("capacity.title")}
      />

      <AssetSection
        className={embedded ? undefined : lastSectionSpacing}
        icon={<BookOpen size={13} />}
        rows={[
          {
            icon: GitBranch,
            id: "repository",
            label: t("context.workspace"),
            meta: t("context.workspaceMeta", {
              name: workspace.name,
              baseline: workspace.baseline,
            }),
            status: { label: t("status.synced"), tone: "online", width: 80 },
          },
          {
            icon: FileIcon,
            id: "agents",
            label: "AGENTS.md",
            meta: agentsFile?.path ?? notReported,
            status: {
              label: agentsFile ? t("status.present") : t("status.missing"),
              tone: agentsFile ? "online" : "neutral",
              width: 80,
            },
          },
        ]}
        title={t("context.title")}
      />
    </PageSurface>
  );
}
