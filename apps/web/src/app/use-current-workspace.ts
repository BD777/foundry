import { useMemo, useState } from "react";
import type { FoundryData } from "../api-types";
import { issueSortValue } from "../lib/issue-meta";
import { initialDevicePairingMode, type DevicePairingMode } from "./navigation";
import {
  currentDevice,
  currentProviderHealth,
  currentWorkspaceAgents,
  currentWorkspaceAssets,
  currentWorkspaceItems,
  workspaceActiveSkillIds,
} from "./workspace-selectors";

/** The workspace data the shown workspace's pages and the sidebar share. */
export function useCurrentWorkspace(
  data: FoundryData,
  selectedIssueId: string,
) {
  const [devicePairingMode] = useState<DevicePairingMode>(
    initialDevicePairingMode,
  );
  const sortedIssues = useMemo(() => {
    return [...data.issues].sort(
      (a, b) => issueSortValue(a) - issueSortValue(b),
    );
  }, [data.issues]);

  const selectedIssue = useMemo(() => {
    return (
      sortedIssues.find((issue) => issue.id === selectedIssueId) ??
      sortedIssues[0]
    );
  }, [sortedIssues, selectedIssueId]);

  const assets = useMemo(
    () => currentWorkspaceAssets(data.assets, data.workspace.id),
    [data.assets, data.workspace.id],
  );

  const activeSkillCount = useMemo(
    () =>
      workspaceActiveSkillIds(
        data.workspaceSkillBindings,
        data.inheritedSkillIds,
        data.offSkillIds,
      ).size,
    [data.workspaceSkillBindings, data.inheritedSkillIds, data.offSkillIds],
  );

  const agents = useMemo(
    () => currentWorkspaceAgents(data.agents, data.workspace),
    [data.agents, data.workspace],
  );
  const device = currentDevice(data.devices, data.workspace);
  const files = useMemo(
    () => currentWorkspaceItems(data.workspaceFiles, data.workspace.id),
    [data.workspace.id, data.workspaceFiles],
  );
  const sessions = useMemo(
    () => currentWorkspaceItems(data.agentSessions, data.workspace.id),
    [data.agentSessions, data.workspace.id],
  );
  const providerHealth = useMemo(
    () =>
      currentProviderHealth(
        data.providerHealth.filter((row) => row.deviceId === device?.id),
        agents,
      ),
    [data.providerHealth, agents, device?.id],
  );

  return {
    activeSkillCount,
    agents,
    assets,
    device,
    deviceOnline:
      devicePairingMode === "online" ||
      (devicePairingMode === "auto" && device?.status === "connected"),
    files,
    providerHealth,
    reviewCount: sortedIssues.filter((issue) => issue.status === "verifying")
      .length,
    runningCount: sortedIssues.filter((issue) => issue.status === "in_progress")
      .length,
    selectedIssue,
    sessions,
    sortedIssues,
  };
}

export type CurrentWorkspace = ReturnType<typeof useCurrentWorkspace>;
