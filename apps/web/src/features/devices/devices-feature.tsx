import { useRef, useState } from "react";
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
} from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { PageSurface } from "../../components/ui/page-surface";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { DeviceWorkspaces } from "./device-workspaces";
import { DeviceAccess } from "./device-access";
import { DeviceSettings } from "./device-settings";
import { DeviceSkills } from "./device-skills";
import { DeviceRemovalDialog } from "./device-removal-dialog";
import { AddDevicePanel } from "./add-device-panel";
import { Alert } from "../../components/ui/alert";

export type DeviceSection = "workspaces" | "agents" | "skills" | "settings";
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
  const removalTriggers = useRef(new Map<string, HTMLButtonElement>());

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
              <h1>Devices</h1>
              <p>
                Choose a device to browse its workspaces, manage agent logins,
                or configure execution.
              </p>
            </div>
            {addingDevice ? null : (
              <Button onClick={() => setAddingDevice(true)} variant="primary">
                <Plus size={15} />
                Add device
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
                      {deviceWorkspaces(row.id).length} workspaces · Last seen{" "}
                      {row.lastSeenLabel}
                    </small>
                  </span>
                  <Badge
                    tone={row.status === "connected" ? "online" : "neutral"}
                  >
                    {row.status === "connected" ? "Online" : "Offline"}
                  </Badge>
                  <span>View →</span>
                </Button>
                {!row.owned ? (
                  <Badge tone="neutral">Shared with you</Badge>
                ) : (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button
                        className="fdy-device-removal-menu-trigger"
                        size="sm"
                        variant="ghost"
                        aria-label={`Actions for ${row.label}`}
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
                          Remove from Foundry…
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
              title="No devices connected"
              body="Use Add device to pair a Foundry worker with this server. It will appear here, along with its registered workspaces."
            />
          ) : null}
        </>
      ) : !device ? (
        <>
          <EmptyState
            title="Device not found"
            body="This device is no longer registered. Your active workspace has not changed."
          />
          <Button onClick={() => onSelect()}>Back to devices</Button>
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
            All devices
          </Button>
          <header className="fdy-management-heading">
            <div>
              <h1>{device.label}</h1>
              <p>
                {device.owned ? "Device settings" : "Shared device"} · Viewing
                this device does not switch your workspace.
              </p>
            </div>
            <Badge tone={device.status === "connected" ? "online" : "neutral"}>
              {device.status === "connected" ? "Online" : "Offline"}
            </Badge>
          </header>
          {device.status !== "connected" ? (
            <p className="fdy-device-offline" role="status">
              This device is offline. Saved workspaces and history remain
              available; sign-in and execution require reconnection.
            </p>
          ) : null}
          {device.owned ? (
            <SegmentedControl
              tone="navigation"
              aria-label="Device sections"
              value={section}
              onValueChange={(next) => onSelect(device.id, next)}
              options={[
                { value: "workspaces", label: "Workspaces" },
                { value: "agents", label: "Models & accounts" },
                { value: "skills", label: "Skills" },
                { value: "settings", label: "Settings" },
              ]}
            />
          ) : (
            <Alert title="Shared with you">
              You reach this device through its workspaces. Models, accounts,
              skills and settings are managed by the account that paired it.
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
