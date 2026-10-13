import {
  resourceTypeIds,
  type ResourceBackend,
  type ResourceInstance,
  type ResourceList,
  type ResourcePlatform,
  type ResourceReadiness,
  type ResourceSource,
  type ResourceSourceStatus,
  type ResourceTypeId,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";

export interface ResourceFilter {
  /** "" for every type. */
  type: ResourceTypeId | "";
  /** A source id; "" for every device. */
  device: string;
}

export interface ResourceDeviceGroup {
  source: ResourceSource;
  status?: ResourceSourceStatus;
  instances: ResourceInstance[];
}

export interface ResourceTypeGroup {
  type: ResourceTypeId;
  devices: ResourceDeviceGroup[];
}

/** A type named by a URL: one of the contract's, else every type. */
export function resourceTypeFrom(value: string): ResourceTypeId | "" {
  return resourceTypeIds.find((type) => type === value) ?? "";
}

function byLabel(a: ResourceSource, b: ResourceSource): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/** Instances that pass the filter, by type (the contract's order), then device. */
export function groupResources(
  list: ResourceList,
  filter: ResourceFilter,
): ResourceTypeGroup[] {
  const statusById = new Map(list.sources.map((source) => [source.id, source]));
  const types = new Map<ResourceTypeId, Map<string, ResourceDeviceGroup>>();
  for (const instance of list.instances) {
    if (filter.type && instance.type !== filter.type) continue;
    if (filter.device && instance.source.id !== filter.device) continue;
    const devices = types.get(instance.type) ?? new Map();
    types.set(instance.type, devices);
    const group = devices.get(instance.source.id) ?? {
      source: instance.source,
      status: statusById.get(instance.source.id),
      instances: [],
    };
    devices.set(instance.source.id, group);
    group.instances.push(instance);
  }
  const order = (type: ResourceTypeId) => {
    const index = resourceTypeIds.indexOf(type);
    return index === -1 ? resourceTypeIds.length : index;
  };
  return [...types.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([type, devices]) => ({
      type,
      devices: [...devices.values()]
        .sort((a, b) => byLabel(a.source, b.source))
        .map((group) => ({
          ...group,
          instances: [...group.instances].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        })),
    }));
}

/** Every source a person can filter by, by label. */
export function resourceSources(list: ResourceList): ResourceSource[] {
  const sources = new Map<string, ResourceSource>();
  for (const source of list.sources) sources.set(source.id, source);
  for (const instance of list.instances)
    if (!sources.has(instance.source.id))
      sources.set(instance.source.id, instance.source);
  return [...sources.values()].sort(byLabel);
}

/** What went wrong detecting, for the sources and types the filter shows. */
export function detectionProblems(
  list: ResourceList,
  filter: ResourceFilter,
): string[] {
  const problems: string[] = [];
  for (const source of [...list.sources].sort(byLabel)) {
    if (filter.device && source.id !== filter.device) continue;
    if (!source.online)
      problems.push(
        i18n.t("resources:problems.offline", { device: source.label }),
      );
    for (const failure of source.detectorErrors) {
      if (filter.type && failure.type !== filter.type) continue;
      problems.push(
        i18n.t("resources:problems.detectorError", {
          device: source.label,
          type: resourceTypeLabel(failure.type),
          error: failure.error || failure.detector,
        }),
      );
    }
  }
  return problems;
}

export function resourceTypeLabel(type: ResourceTypeId): string {
  return resourceTypeIds.includes(type)
    ? i18n.t(`resources:types.${type}`)
    : type;
}

/**
 * What the instance's headline says: a backend Foundry operates remotely
 * (cua-driver) decides it, since sessions lease the instance through it;
 * others (the worker's own grants, for sessions on the device) are listed
 * under it.
 */
export function headlineReadiness(
  instance: Pick<ResourceInstance, "readiness" | "backends">,
): ResourceReadiness {
  return (
    instance.backends.find((backend) => backend.mode === "remote_ops")
      ?.readiness ?? instance.readiness
  );
}

/** Backends with the remotely operated ones first. */
export function leadingBackendsFirst(
  backends: readonly ResourceBackend[],
): ResourceBackend[] {
  return [
    ...backends.filter((backend) => backend.mode === "remote_ops"),
    ...backends.filter((backend) => backend.mode !== "remote_ops"),
  ];
}

/** "Ready · permitted", "Not ready · installed — <reason>". */
export function readinessText(readiness: ResourceReadiness): string {
  const level = i18n.t(`resources:levels.${readiness.level}`, {
    defaultValue: readiness.level,
  });
  const words = i18n.t(
    readiness.ready
      ? "resources:readiness.ready"
      : "resources:readiness.notReady",
    { level },
  );
  return !readiness.ready && readiness.reason
    ? i18n.t("resources:readiness.withReason", {
        readiness: words,
        reason: readiness.reason,
      })
    : words;
}

export function stateTone(
  state: ResourceInstance["state"],
): NonNullable<BadgeProps["tone"]> {
  switch (state) {
    case "available":
      return "online";
    case "busy":
      return "brass";
    case "unready":
      return "warn";
    case "offline":
      return "slate";
    case "gone":
      return "neutral";
  }
}

/** "foundry-worker 0.9.1 (detected)", "cua-driver (operated through Foundry)". */
export function backendLabel(backend: ResourceBackend): string {
  const name = backend.version
    ? i18n.t("resources:backend.named", {
        id: backend.id,
        version: backend.version,
      })
    : backend.id;
  return i18n.t("resources:backend.withMode", {
    name,
    mode: i18n.t(`resources:backend.${backend.mode}`, {
      defaultValue: backend.mode,
    }),
  });
}

/** What is missing, in words: "Accessibility permission, …". */
export function missingText(missing: readonly string[]): string {
  return missing
    .map((code) => i18n.t(`resources:missing.${code}`, { defaultValue: code }))
    .join(", ");
}

const osPlatforms: Record<string, ResourcePlatform | undefined> = {
  darwin: "macos",
  macos: "macos",
  win32: "windows",
  windows: "windows",
  linux: "linux",
};

/** A compute instance's details in words: "10 CPUs · 16 GiB · macOS arm64 · load 1.2". */
export function computeDetailsText(details: Record<string, string>): string {
  const parts: string[] = [];
  const cpus = Number(details.cpus);
  if (details.cpus && Number.isFinite(cpus))
    parts.push(i18n.t("resources:compute.cpus", { count: cpus }));
  if (details.memoryGiB)
    parts.push(i18n.t("resources:compute.memory", { gib: details.memoryGiB }));
  const platform = osPlatforms[details.os?.toLowerCase() ?? ""];
  const os = platform
    ? i18n.t(`resources:platforms.${platform}`)
    : (details.os ?? "");
  const system = [os, details.arch ?? ""].filter(Boolean).join(" ");
  if (system) parts.push(system);
  if (details.loadAvg)
    parts.push(i18n.t("resources:compute.load", { load: details.loadAvg }));
  return parts.join(" · ");
}

/** "15:42" today; with the date on another day. */
export function clockTime(iso: string | undefined, now = new Date()): string {
  const at = iso ? new Date(iso) : undefined;
  if (!at || !Number.isFinite(at.getTime())) return "";
  const sameDay = at.toDateString() === now.toDateString();
  return at.toLocaleString(i18n.language, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}
