import { useTranslation } from "react-i18next";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { WorkspaceAgentDefaultFeature } from "../features/agent-defaults";
import { AssetsFeature } from "../features/assets";
import { ChannelsFeature } from "../features/channels";
import { WorkspaceConnectorsFeature } from "../features/external-accounts";
import { SharingFeature } from "../features/sharing";
import { SkillsFeature } from "../features/skills";
import {
  WorkspaceHub,
  WorkspaceOverview,
  type WorkspaceSection,
} from "../features/workspaces";
import { workspaceDenial } from "../lib/workspace-access";
import type { AppViewContext } from "./active-view";
import { useAccountSession } from "./accounts-gate";
import { assetsViewFields, skillsViewFields } from "./view-fields";

export interface WorkspaceHubViewProps extends AppViewContext {
  section?: WorkspaceSection;
}

/** The shown workspace's pages: overview, settings, assets, skills, sharing… */
export function WorkspaceHubView({
  section = "workspace",
  ...context
}: WorkspaceHubViewProps) {
  const { current, location, setNotice, workspaceData } = context;
  const { data } = workspaceData;
  const { device } = current;
  const { t } = useTranslation("shell");
  const account = useAccountSession();
  return (
    <WorkspaceHub
      workspace={data.workspace}
      section={section}
      onSectionChange={location.setActiveView}
      selector={null}
    >
      {section === "workspace" ? (
        <WorkspaceOverview
          key={data.workspace.id}
          workspace={data.workspace}
          deviceOnline={current.deviceOnline}
          deviceLabel={device?.label}
          acceptedCount={
            current.sortedIssues.filter((issue) => issue.status === "accepted")
              .length
          }
        />
      ) : null}
      {section === "settings" ? (
        <div className="fdy-workspace-settings">
          {data.workspace.id ? (
            <WorkspaceAgentDefaultFeature
              key={data.workspace.id}
              deviceId={data.workspace.deviceId}
              onNotice={setNotice}
              profiles={data.agentProfiles}
              readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
              workspaceId={data.workspace.id}
            />
          ) : null}
          {device && !device.owned ? (
            <Alert title={t("settings.managedByOwner")}>
              {t("settings.managedByOwnerBody", { device: device.label })}
            </Alert>
          ) : (
            <Button
              className="fdy-workspace-settings-manage"
              variant="secondary"
              size="sm"
              onClick={() => location.openDevices(device?.id, "agents")}
            >
              {t("settings.manageAgents", {
                device: device?.label ?? t("settings.thisDevice"),
              })}
            </Button>
          )}
        </div>
      ) : null}
      {section === "assets" ? <WorkspaceAssets {...context} /> : null}
      {section === "skills" ? <WorkspaceSkills {...context} /> : null}
      {section === "sharing" ? (
        <SharingFeature
          key={data.workspace.id}
          workspace={data.workspace}
          deviceLabel={device?.label}
          currentUserId={account.user?.id ?? ""}
          canInvite={account.user?.role === "admin"}
          onLeft={() => {
            setNotice(
              t("notices.leftWorkspace", { workspace: data.workspace.name }),
            );
            // The server ends this account's stream; it resyncs, and the
            // whole read then shows another workspace.
            location.setActiveView("locations");
          }}
        />
      ) : null}
      {section === "channels" ? (
        <ChannelsFeature
          key={data.workspace.id}
          readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
          workspaceId={data.workspace.id}
          workspaceName={data.workspace.name}
          workspaceNameOf={(id) =>
            data.workspaces.find((workspace) => workspace.id === id)?.name
          }
          currentUserId={account.user?.id}
          deviceId={data.workspace.deviceId}
          profiles={data.agentProfiles}
          onNotice={setNotice}
          onOpenChats={() => location.setActiveView("chats")}
          onOpenConnectors={() => location.setActiveView("connectors")}
        />
      ) : null}
      {section === "workspaceConnectors" ? (
        <WorkspaceConnectorsFeature
          currentUserId={account.user?.id ?? ""}
          onNotice={setNotice}
          readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
          workspaceId={data.workspace.id}
        />
      ) : null}
    </WorkspaceHub>
  );
}

function WorkspaceAssets({
  current,
  setNotice,
  workspaceData,
}: AppViewContext) {
  const { t } = useTranslation("shell");
  const { data, refreshData } = workspaceData;
  return (
    <AssetsFeature
      embedded
      agents={current.agents}
      assets={current.assets}
      device={current.device}
      deviceOnline={current.deviceOnline}
      files={current.files}
      onEvent={(event) => {
        if (event.type === "data.refresh.requested") {
          void refreshData({ fields: assetsViewFields });
        } else {
          setNotice(t("notices.openDaemonLogs"));
        }
      }}
      providerHealth={current.providerHealth}
      runningCount={current.runningCount}
      workspace={data.workspace}
    />
  );
}

function WorkspaceSkills({
  location,
  setNotice,
  workspaceData,
}: AppViewContext) {
  const { data, pageFieldsLoaded, refreshData } = workspaceData;
  return (
    <SkillsFeature
      bindings={data.workspaceSkillBindings}
      catalog={data.promotedSkills}
      catalogLoading={!pageFieldsLoaded.has("promotedSkills")}
      devices={data.devices}
      embedded
      onChanged={() => refreshData({ silent: true, fields: skillsViewFields })}
      onEvent={(event) => {
        if (event.type === "notice.requested") {
          setNotice(event.message, event.tone);
          return;
        }
        location.openDevices(undefined, "skills");
      }}
      workspaceId={data.workspace.id}
      workspaceDeviceId={data.workspace.deviceId}
      providerHealth={data.providerHealth.filter(
        (row) => row.deviceId === data.workspace.deviceId,
      )}
      builtinSkills={data.builtinSkills}
      defaultSkillIds={data.defaultSkillIds}
      deviceTools={data.deviceTools}
      skillBundles={data.skillBundles}
      workspaceBundleIds={data.workspaceBundleIds}
      defaultBundleIds={data.defaultBundleIds}
      inheritedSkillIds={data.inheritedSkillIds}
      offSkillIds={data.offSkillIds}
      workspaces={data.workspaces}
      readOnlyReason={workspaceDenial(data.workspace, "maintainer")}
    />
  );
}
