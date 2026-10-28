import type {
  DeviceProjection,
  DeviceStatusChangedPayload,
} from "@bd777/foundry-protocol";
import type { FoundryData, FoundryDataField } from "../../api-types";
import { carriedData } from "../../stream/carried-data";
import {
  eachPayload,
  keepStreamed,
  type LoadedMerges,
  type StreamProjections,
} from "./stream-projection";

/** Devices a live event replaced. */
export const deviceTouchKinds = ["devices"] as const;

/** Status changes of devices are read after this quiet period. */
export const deviceRefreshDelayMs = 1_500;

/**
 * What a device status event leaves for a read: agents and agent profiles
 * are usable only while their device is online, and a device coming online
 * may serve other workspaces now; the device itself when the event lacks it.
 */
const deviceEventFields: readonly FoundryDataField[] = [
  "agentProfiles",
  "agents",
  "workspaces",
  // A device's scan folders are its defaults until set.
  "deviceSkillRoots",
];

/**
 * The whole device a status event carries (newer servers), as workspace
 * data lists it to a viewer who does not own it. Undefined for status only.
 */
export function streamedDevice(
  payload: DeviceStatusChangedPayload,
): DeviceProjection | undefined {
  return carriedData("device_status_changed", payload);
}

/**
 * Whether a device event leaves something only a read can show: an event
 * without the whole device, a device this tab does not list yet, or a
 * status change either way (agents and profiles are usable only while their
 * device is online, which the event does not carry). A device that changed
 * otherwise (its worker update moved on) is all in the event; what else its
 * report changed, such as the workspaces it serves now, the server
 * announces (foundry_data_changed).
 */
export function deviceEventNeedsRefresh(
  data: Pick<FoundryData, "devices">,
  event: { payload: DeviceStatusChangedPayload },
): boolean {
  const shown = data.devices.find(
    (device) => device.id === event.payload.deviceId,
  );
  return (
    !streamedDevice(event.payload) ||
    !shown ||
    shown.status !== event.payload.status
  );
}

/**
 * What the server adds to a device for this viewer only (whether they own
 * it, and what only its owner sees); a shared status event never has them.
 */
const viewerOwnDeviceFields = [
  "owned",
  "runtimeSettings",
  "sharesSystemAccountWith",
  "outsideFilesOff",
] as const satisfies readonly (keyof DeviceProjection)[];

/** A shared device projection with `viewer`'s own fields. */
function withViewerOwnFields(
  device: DeviceProjection,
  viewer: DeviceProjection,
): DeviceProjection {
  const result: DeviceProjection = { ...device };
  for (const key of viewerOwnDeviceFields) {
    delete result[key];
    if (viewer[key] !== undefined)
      Object.assign(result, { [key]: viewer[key] });
  }
  return result;
}

/** A device the data lists, replaced by the event's or given its status. */
function applyDeviceStatus(
  data: FoundryData,
  payload: DeviceStatusChangedPayload,
): FoundryData {
  const { deviceId, status } = payload;
  if (!data.devices.some((device) => device.id === deviceId)) return data;
  const streamed = streamedDevice(payload);
  return {
    ...data,
    devices: data.devices.map((device) => {
      if (device.id !== deviceId) return device;
      if (!streamed) {
        return {
          ...device,
          status,
          lastSeenLabel: status === "connected" ? "online" : "offline",
        };
      }
      return withViewerOwnFields(streamed, device);
    }),
  };
}

export const deviceProjections = {
  device_status_changed: {
    apply: eachPayload(applyDeviceStatus),
    reads: (payload, view) => {
      if (!deviceEventNeedsRefresh(view, { payload })) return undefined;
      const listed =
        streamedDevice(payload) &&
        view.devices.some((device) => device.id === payload.deviceId);
      return {
        delayMs: deviceRefreshDelayMs,
        fields: listed ? deviceEventFields : [...deviceEventFields, "devices"],
      };
    },
    touches: (payload) => [["devices", payload.deviceId]],
  },
} satisfies StreamProjections;

export const deviceLoadedMerges = {
  // A device an event replaced after the read started stays as shown,
  // with what the read tells only this viewer, which events never carry
  // (such as the owner's switch just saved).
  devices: (current, loaded, touched) => {
    const kept = keepStreamed(
      current.devices,
      loaded.devices,
      touched?.devices,
    );
    if (!touched?.devices?.size) return kept;
    const read = new Map(loaded.devices.map((device) => [device.id, device]));
    return kept.map((device) => {
      const fresh = read.get(device.id);
      return fresh && fresh !== device
        ? withViewerOwnFields(device, fresh)
        : device;
    });
  },
} satisfies LoadedMerges;
