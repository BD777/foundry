import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Pencil, Plus, RefreshCw } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  DeviceSkillRoot,
  ProfileDefinition,
  ProviderHealth,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { DeviceAccess } from "./device-access";
import { DeviceDiagnostics } from "./device-diagnostics";
import { DeviceResources } from "./device-resources";
import {
  DeviceWorker,
  UpdateAllWorkersButton,
  UpdateAllWorkersStatus,
  useUpdateAllWorkers,
} from "./device-worker";
import { useWorkerRelease } from "../../lib/worker-commands";
import { DeviceSettings } from "./device-settings";
import { DeviceSkills } from "./device-skills";
import { DeviceRemovalDialog } from "./device-removal-dialog";
import { DeviceRenameDialog } from "./device-rename-dialog";
import { DeviceDetails } from "./device-details";
import { DeviceList } from "./device-list";
import { AddDeviceDialog } from "./add-device-dialog";
import { Alert } from "../../components/ui/alert";
import { liveDevices } from "../../lib/devices";

export type DeviceSection =
  "agents" | "resources" | "skills" | "settings" | "diagnostics";
export interface DevicesFeatureProps {
  devices: DeviceProjection[];
  selectedDeviceId?: string;
  section: DeviceSection;
  activeWorkspaceId: string;
  workspaces: WorkspaceProjection[];
  profiles: ProfileDefinition[];
  agentProfiles: AgentProfileProjection[];
  deviceProfiles: DeviceProfileBinding[];
  deviceSkillRoots: DeviceSkillRoot[];
  providerHealth: ProviderHealth[];
  onSelect: (deviceId?: string, section?: DeviceSection) => void;
  onOpenWorkspace: (workspaceId: string) => Promise<boolean>;
  /** Shows this device's workspaces on the Workspaces page. */
  onOpenWorkspaces: (deviceId: string) => void;
  onRefresh: () => Promise<void>;
  onManageConnections: () => void;
}

export function DevicesFeature(props: DevicesFeatureProps) {
  const {
    devices,
    selectedDeviceId,
    section,
    onSelect,
    workspaces,
    onRefresh,
  } = props;
  // Soft-removed devices stay in the data (history views still resolve their
  // label) but never appear as available, selectable devices.
  const availableDevices = liveDevices(devices);
  const device = availableDevices.find((row) => row.id === selectedDeviceId);
  const ownProfiles = props.agentProfiles.filter(
    (row) => row.deviceId === selectedDeviceId,
  );
  const [removalTarget, setRemovalTarget] = useState<DeviceProjection>();
  const [renameTarget, setRenameTarget] = useState<DeviceProjection>();
  const renameReturn = useRef<HTMLElement | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const removalTriggers = useRef(new Map<string, HTMLButtonElement>());
  const { t } = useTranslation("devices");
  const { release } = useWorkerRelease();
  const [refreshing, setRefreshing] = useState(false);
  const updateAll = useUpdateAllWorkers(availableDevices, release, onRefresh);

  function deviceWorkspaces(deviceId: string): WorkspaceProjection[] {
    return workspaces.filter((workspace) => workspace.deviceId === deviceId);
  }

  async function handleDeviceRemoved(removed: DeviceProjection): Promise<void> {
    try {
      await onRefresh();
    } catch {
      // The removal already succeeded; the list view simply reflects it on
      // the next successful load.
    }
    if (selectedDeviceId === removed.id) {
      onSelect();
    }
  }

  return (
    <PageSurface variant="devices">
      {!selectedDeviceId ? (
        <>
          <header className="fdy-management-heading">
            <div>
              <h1>{t("list.title")}</h1>
              <p>{t("list.intro")}</p>
            </div>
            <div className="fdy-device-heading-actions">
              <Button
                aria-busy={refreshing}
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  void onRefresh()
                    .catch(() => {})
                    .finally(() => setRefreshing(false));
                }}
                variant="ghost"
              >
                <RefreshCw size={15} />
                {refreshing ? t("list.refreshing") : t("list.refresh")}
              </Button>
              <UpdateAllWorkersButton state={updateAll} />
              <Button onClick={() => setAddingDevice(true)} variant="primary">
                <Plus size={15} />
                {t("list.add")}
              </Button>
            </div>
          </header>
          <UpdateAllWorkersStatus state={updateAll} />
          {addingDevice ? (
            <AddDeviceDialog onClose={() => setAddingDevice(false)} />
          ) : null}
          <DeviceList
            devices={availableDevices}
            release={release}
            workspaceCount={(id) => deviceWorkspaces(id).length}
            triggers={removalTriggers.current}
            onOpen={(id) => onSelect(id)}
            onRename={(row) => {
              renameReturn.current =
                removalTriggers.current.get(row.id) ?? null;
              setRenameTarget(row);
            }}
            onRemove={setRemovalTarget}
          />
          {!availableDevices.length ? (
            <EmptyState
              title={t("list.emptyTitle")}
              body={t("list.emptyBody")}
            />
          ) : null}
        </>
      ) : !device ? (
        <>
          <EmptyState
            title={t("detail.notFoundTitle")}
            body={t("detail.notFoundBody")}
          />
          <Button onClick={() => onSelect()}>
            {t("detail.backToDevices")}
          </Button>
        </>
      ) : (
        <>
          <Button
            className="fdy-device-back"
            size="sm"
            variant="ghost"
            onClick={() => onSelect()}
          >
            <ArrowLeft size={14} />
            {t("detail.allDevices")}
          </Button>
          <header className="fdy-management-heading">
            <div>
              <h1>{device.label}</h1>
              <p>
                {t(device.owned ? "detail.ownedNote" : "detail.sharedNote")}
              </p>
            </div>
            <div className="fdy-device-heading-actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => props.onOpenWorkspaces(device.id)}
              >
                {t("detail.workspacesLink", {
                  count: deviceWorkspaces(device.id).length,
                })}
                <ArrowRight size={14} />
              </Button>
              {device.owned ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(event) => {
                    renameReturn.current = event.currentTarget;
                    setRenameTarget(device);
                  }}
                >
                  <Pencil size={14} />
                  {t("rename.action")}
                </Button>
              ) : null}
              <Badge
                tone={device.status === "connected" ? "online" : "neutral"}
              >
                {t(
                  device.status === "connected"
                    ? "status.online"
                    : "status.offline",
                )}
              </Badge>
            </div>
          </header>
          {device.status !== "connected" ? (
            <p className="fdy-device-offline" role="status">
              {t("detail.offline")}
            </p>
          ) : null}
          <DeviceDetails device={device} />
          {device.owned ? (
            <DeviceWorker device={device} prominent onRefresh={onRefresh} />
          ) : null}
          {device.owned ? (
            <SegmentedControl
              tone="navigation"
              aria-label={t("detail.sections")}
              value={section}
              onValueChange={(next) => onSelect(device.id, next)}
              options={[
                { value: "agents", label: t("detail.sectionAgents") },
                { value: "resources", label: t("detail.sectionResources") },
                { value: "skills", label: t("detail.sectionSkills") },
                { value: "settings", label: t("detail.sectionSettings") },
                {
                  value: "diagnostics",
                  label: t("detail.sectionDiagnostics"),
                },
              ]}
            />
          ) : (
            <Alert title={t("detail.sharedTitle")}>
              {t("detail.sharedBody")}
            </Alert>
          )}
          <div key={device.id} className="fdy-device-content">
            {section === "resources" || !device.owned ? (
              <DeviceResources device={device} onRefresh={onRefresh} />
            ) : null}
            {section === "agents" && device.owned ? (
              <DeviceAccess
                {...props}
                device={device}
                ownProfiles={ownProfiles}
              />
            ) : null}
            {section === "skills" && device.owned ? (
              <DeviceSkills
                device={device}
                onChanged={onRefresh}
                roots={props.deviceSkillRoots.filter(
                  (root) => root.deviceId === device.id,
                )}
                workspaces={deviceWorkspaces(device.id)}
              />
            ) : null}
            {section === "settings" && device.owned ? (
              <DeviceWorker device={device} onRefresh={onRefresh} />
            ) : null}
            {section === "diagnostics" && device.owned ? (
              <DeviceDiagnostics device={device} onRefresh={onRefresh} />
            ) : null}
            {section === "settings" && device.owned ? (
              <DeviceSettings
                device={device}
                onRefresh={onRefresh}
                onRemoveDevice={() => setRemovalTarget(device)}
              />
            ) : null}
          </div>
        </>
      )}
      {renameTarget ? (
        <DeviceRenameDialog
          device={renameTarget}
          returnFocusTo={renameReturn.current}
          onClose={() => setRenameTarget(undefined)}
          onSaved={onRefresh}
        />
      ) : null}
      {removalTarget ? (
        <DeviceRemovalDialog
          device={removalTarget}
          workspaces={deviceWorkspaces(removalTarget.id)}
          activeWorkspaceId={props.activeWorkspaceId}
          returnFocusTo={removalTriggers.current.get(removalTarget.id) ?? null}
          onClose={() => setRemovalTarget(undefined)}
          onRemoved={handleDeviceRemoved}
        />
      ) : null}
    </PageSurface>
  );
}
