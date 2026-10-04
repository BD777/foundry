import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, Monitor, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  DeviceSkill,
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
import { DeviceWorkspaces } from "./device-workspaces";
import { DeviceAccess } from "./device-access";
import { DeviceResources } from "./device-resources";
import { DeviceSettings } from "./device-settings";
import { DeviceSkills } from "./device-skills";
import { DeviceRemovalDialog } from "./device-removal-dialog";
import { AddDevicePanel } from "./add-device-panel";
import { Alert } from "../../components/ui/alert";

export type DeviceSection =
  "workspaces" | "resources" | "agents" | "skills" | "settings";
export interface DevicesFeatureProps {
  /** Changes each time another page asks to add a device. */
  addDeviceRequest?: number;
  devices: DeviceProjection[];
  selectedDeviceId?: string;
  section: DeviceSection;
  activeWorkspaceId: string;
  workspaces: WorkspaceProjection[];
  profiles: ProfileDefinition[];
  agentProfiles: AgentProfileProjection[];
  deviceProfiles: DeviceProfileBinding[];
  deviceSkillRoots: DeviceSkillRoot[];
  deviceSkills: DeviceSkill[];
  providerHealth: ProviderHealth[];
  onSelect: (deviceId?: string, section?: DeviceSection) => void;
  onOpenWorkspace: (workspaceId: string) => Promise<boolean>;
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
  const availableDevices = devices.filter((row) => row.status !== "removed");
  const device = availableDevices.find((row) => row.id === selectedDeviceId);
  const ownProfiles = props.agentProfiles.filter(
    (row) => row.deviceId === selectedDeviceId,
  );
  const [removalTarget, setRemovalTarget] = useState<DeviceProjection>();
  const [addingDevice, setAddingDevice] = useState(false);
  useEffect(() => {
    if (props.addDeviceRequest) setAddingDevice(true);
  }, [props.addDeviceRequest]);
  const removalTriggers = useRef(new Map<string, HTMLButtonElement>());
  const { t } = useTranslation("devices");

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
            {addingDevice ? null : (
              <Button onClick={() => setAddingDevice(true)} variant="primary">
                <Plus size={15} />
                {t("list.add")}
              </Button>
            )}
          </header>
          {addingDevice ? (
            <AddDevicePanel onClose={() => setAddingDevice(false)} />
          ) : null}
          <div className="fdy-device-list">
            {availableDevices.map((row) => (
              <div
                className="fdy-device-list-row fdy-device-removal-row"
                key={row.id}
              >
                <Button
                  className="fdy-device-removal-row-main"
                  variant="ghost"
                  onClick={() => onSelect(row.id, "workspaces")}
                >
                  <Monitor size={25} />
                  <span>
                    <strong>{row.label}</strong>
                    <small>
                      {t("list.workspaceCount", {
                        count: deviceWorkspaces(row.id).length,
                      })}
                    </small>
                  </span>
                  <Badge
                    tone={row.status === "connected" ? "online" : "neutral"}
                  >
                    {t(
                      row.status === "connected"
                        ? "status.online"
                        : "status.offline",
                    )}
                  </Badge>
                  <span>{t("list.view")}</span>
                </Button>
                {!row.owned ? (
                  <Badge tone="neutral">{t("list.sharedWithYou")}</Badge>
                ) : (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button
                        className="fdy-device-removal-menu-trigger"
                        size="sm"
                        variant="ghost"
                        aria-label={t("list.actionsFor", { device: row.label })}
                        ref={(element) => {
                          if (element)
                            removalTriggers.current.set(row.id, element);
                          else removalTriggers.current.delete(row.id);
                        }}
                      >
                        <MoreHorizontal size={17} />
                      </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="fdy-workspace-actions-menu"
                        align="end"
                        sideOffset={6}
                      >
                        <DropdownMenu.Item
                          className="fdy-workspace-menu-item"
                          onSelect={() => setRemovalTarget(row)}
                        >
                          <Trash2 size={15} />
                          {t("list.removeFromFoundry")}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            ))}
          </div>
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
            <Badge tone={device.status === "connected" ? "online" : "neutral"}>
              {t(
                device.status === "connected"
                  ? "status.online"
                  : "status.offline",
              )}
            </Badge>
          </header>
          {device.status !== "connected" ? (
            <p className="fdy-device-offline" role="status">
              {t("detail.offline")}
            </p>
          ) : null}
          {device.owned ? (
            <SegmentedControl
              tone="navigation"
              aria-label={t("detail.sections")}
              value={section}
              onValueChange={(next) => onSelect(device.id, next)}
              options={[
                { value: "workspaces", label: t("detail.sectionWorkspaces") },
                { value: "resources", label: t("detail.sectionResources") },
                { value: "agents", label: t("detail.sectionAgents") },
                { value: "skills", label: t("detail.sectionSkills") },
                { value: "settings", label: t("detail.sectionSettings") },
              ]}
            />
          ) : (
            <Alert title={t("detail.sharedTitle")}>
              {t("detail.sharedBody")}
            </Alert>
          )}
          <div key={device.id} className="fdy-device-content">
            {section === "workspaces" || !device.owned ? (
              <DeviceWorkspaces
                device={device}
                workspaces={workspaces.filter(
                  (row) => row.deviceId === device.id,
                )}
                activeWorkspaceId={props.activeWorkspaceId}
                onOpen={props.onOpenWorkspace}
                onRefresh={onRefresh}
              />
            ) : null}
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
                skills={props.deviceSkills.filter(
                  (skill) => skill.deviceId === device.id,
                )}
              />
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
