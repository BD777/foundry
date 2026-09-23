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
import type {
  AgentProjection,
  AssetProjection,
  DeviceProjection,
  ProviderHealth,
  WorkspaceFileEntry,
  WorkspaceProjection,
} from "@foundry/protocol";
import { AssetSection } from "./asset-section";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DeviceAssetPanel } from "./device-asset-panel";
import { MetaPill } from "../../components/ui/meta-pill";
import { PageSurface } from "../../components/ui/page-surface";
import { SectionLabel } from "../../components/ui/panel";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { Tooltip } from "../../components/ui/tooltip";
import { assetStatusLabel, assetTone } from "../../lib/asset-meta";

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
      ? "just now"
      : (device?.lastSeenLabel ?? "never");

  return (
    <PageSurface variant="assets" embedded={embedded}>
      <SectionLabel>
        <Monitor size={13} />
        Device
      </SectionLabel>
      <DeviceAssetPanel
        actions={
          <>
            <Tooltip content="Logs">
              <Button
                aria-label="Open device logs"
                onClick={() => onEvent?.({ type: "device.logs.requested" })}
                size="icon"
                variant="icon"
              >
                <FileText size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Refresh">
              <Button
                aria-label="Refresh device"
                onClick={() => onEvent?.({ type: "data.refresh.requested" })}
                size="icon"
                variant="icon"
              >
                <RefreshCw size={15} />
              </Button>
            </Tooltip>
          </>
        }
        activeWorkers={`${runningCount} workers active`}
        code={
          <>
            {device?.label ?? "No device"} · last connected{" "}
            {deviceLastSeenLabel}
          </>
        }
        facts={[
          {
            label: "Workdir",
            mono: true,
            value: workspace.localPath.replace("/Users/you/", "~/"),
          },
          {
            label: "Agents",
            value: `${configuredAgentCount}/${agents.length} configured`,
          },
          { label: "Scope", value: "Local device" },
        ]}
        identifier={device?.id ?? "No device"}
        label={device?.label ?? "No device"}
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
                  : "Missing"}
              </Badge>
            ),
            icon: Gauge,
            iconTone: "brass",
            id: "worktree-pool",
            label: worktreeAsset?.name ?? "Worktree pool",
            meta: worktreeAsset?.detail ?? "not reported by daemon",
          },
          {
            end: (
              <Badge
                tone={previewAsset ? assetTone(previewAsset.status) : "online"}
              >
                {previewAsset
                  ? assetStatusLabel(previewAsset.status)
                  : "Available"}
              </Badge>
            ),
            endWidth: 92,
            icon: Monitor,
            iconTone: "neutral",
            id: "preview-ports",
            label: previewAsset?.name ?? "Preview ports",
            meta: previewAsset?.detail ?? "not reported by daemon",
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
                  : "Missing"}
              </Badge>
            ),
            endWidth: 82,
            icon: FolderOpen,
            iconTone: "green",
            id: "artifact-archive",
            label: artifactAsset?.name ?? "Artifact archive",
            meta: artifactAsset?.detail ?? "not reported by daemon",
          },
        ]}
        title="Execution capacity"
      />

      <AssetSection
        icon={<BookOpen size={13} />}
        rows={[
          {
            end: <Badge tone="online">Synced</Badge>,
            endWidth: 80,
            icon: GitBranch,
            id: "repository",
            label: "Workspace",
            meta: `${workspace.name} · configured baseline: ${workspace.baseline}`,
          },
          {
            end: (
              <Badge tone={agentsFile ? "online" : "neutral"}>
                {agentsFile ? "Present" : "Missing"}
              </Badge>
            ),
            endWidth: 80,
            icon: FileIcon,
            id: "agents",
            label: "AGENTS.md",
            meta: agentsFile?.path ?? "not reported by daemon",
          },
          {
            end: (
              <Badge dot={false} tone={skillsFile ? "brass" : "neutral"}>
                {skillsFile ? "Present" : "Missing"}
              </Badge>
            ),
            endWidth: 74,
            icon: Package,
            id: "skills-config",
            label: "Skills config",
            meta: skillsFile
              ? `${skillCount} skills · ${skillsFile.path}`
              : "not reported by daemon",
          },
        ]}
        title="Context"
      />
    </PageSurface>
  );
}
