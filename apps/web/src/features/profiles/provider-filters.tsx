import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import type { NativeRuntime } from "./device-accounts";

export type RuntimeFilter = "all" | NativeRuntime;

/** Narrows every group on the page to one runtime and one device. */
export function ProviderFilters({
  devices,
  deviceId,
  runtime,
  onDeviceChange,
  onRuntimeChange,
}: {
  devices: DeviceProjection[];
  deviceId: string;
  runtime: RuntimeFilter;
  onDeviceChange: (deviceId: string) => void;
  onRuntimeChange: (runtime: RuntimeFilter) => void;
}) {
  const { t } = useTranslation("profiles");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <SegmentedControl<RuntimeFilter>
        aria-label={t("page.runtimeFilter")}
        onValueChange={onRuntimeChange}
        options={[
          { value: "all", label: t("page.allRuntimes") },
          { value: "claude", label: t("page.claudeRuntime") },
          { value: "codex", label: t("page.codexRuntime") },
        ]}
        value={runtime}
      />
      <SelectMenu
        ariaLabel={t("page.deviceFilter")}
        value={deviceId}
        options={[
          { value: "", label: t("page.allDevices") },
          ...devices.map((device) => ({
            value: device.id,
            label: device.label,
          })),
        ]}
        onChange={onDeviceChange}
      />
    </div>
  );
}

/** The connections shown for the chosen runtimes and, when one is picked, device. */
export function filterConnections(
  connections: ProfileDefinition[],
  {
    runtimes,
    deviceId,
    deviceProfiles,
  }: {
    runtimes: NativeRuntime[];
    deviceId: string;
    deviceProfiles: DeviceProfileBinding[];
  },
): ProfileDefinition[] {
  return connections.filter(
    (profile) =>
      runtimes.includes(profile.runtime as NativeRuntime) &&
      (!deviceId ||
        deviceProfiles.some(
          (row) =>
            row.deviceId === deviceId &&
            row.profileId === profile.id &&
            row.enabled,
        )),
  );
}

export function runtimesFor(filter: RuntimeFilter): NativeRuntime[] {
  return filter === "all" ? ["claude", "codex"] : [filter];
}
