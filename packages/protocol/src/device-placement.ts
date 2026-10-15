// Where work may go: what a device's owner says it has (labels) beside what
// Foundry detected from its worker's reports (facts). The Personal Agent
// states what a new project needs in the same key:value words and Foundry
// places it. Mirrors apps/server/internal/store/device_placement.go.

/** Something a device's owner states about it: "network: corp", "gpu". */
export interface DeviceLabel {
  key: string;
  value?: string;
}

/** Where a detected fact came from. */
export type DeviceFactSource =
  "system" | "toolchain" | "gpu" | "connector" | "presence";

/** Something Foundry detected about a device; read-only. */
export interface DeviceFact {
  key: string;
  value?: string;
  /** For people: a version, the network a check names. */
  detail?: string;
  source: DeviceFactSource;
}

/** How much of the last days a device was connected, as the server saw it. */
export interface DeviceOnlineShare {
  /** 0 to 1. */
  ratio: number;
  /** How far back the server followed it, at most a week. */
  observedHours: number;
}

/** One device's labels and facts (GET /api/device-placements). */
export interface DevicePlacement {
  deviceId: string;
  labels: DeviceLabel[];
  facts: DeviceFact[];
  onlineShare?: DeviceOnlineShare;
  labelsUpdatedAt?: string;
}

/** PUT /api/devices/{deviceId}/labels: the owner replaces the labels. */
export interface SetDeviceLabelsInput {
  labels: DeviceLabel[];
}

/** Labels the device page offers; any other key:value is fine. */
export const suggestedDeviceLabels: readonly DeviceLabel[] = [
  { key: "network", value: "corp" },
  { key: "network", value: "home" },
  { key: "network", value: "public" },
  { key: "toolchain", value: "go" },
  { key: "toolchain", value: "node" },
  { key: "toolchain", value: "xcode" },
  { key: "files", value: "personal" },
  { key: "files", value: "work" },
  { key: "gpu" },
  { key: "always-on" },
];

/**
 * create_workspace's answer when no computer the assistant may use has
 * what the work needs; the assistant asks the person one plain question.
 */
export interface PersonalAgentNoPlace {
  status: "no_place_fits";
  /** Needs none of the allowed computers gives, as key:value. */
  missing: string[];
  computers: PersonalAgentPlaceGap[];
  /** For the assistant: what to do now. */
  next: string;
}

/** One computer that does not fit, and why. */
export interface PersonalAgentPlaceGap {
  name: string;
  deviceId: string;
  online: boolean;
  lacks: string[];
  /** Set when the assistant may not create projects there. */
  notAllowed?: string;
}

/** Where create_workspace put a new project and why. */
export interface PersonalAgentPlacement {
  computer: string;
  deviceId: string;
  online: boolean;
  reason: string;
  /** Needs the computer the assistant named does not show. */
  unverified?: string[];
}
