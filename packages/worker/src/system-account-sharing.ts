/**
 * Who else uses this device's system account in Foundry, as the server
 * last said (device_sharing; docs/devices-and-workspaces.md, "一台电脑上的几个人").
 * Sessions are told, so agents never assume what is here is private to the
 * person they work for. Kept in the state root so a session started before
 * the server says it again after a restart still hears it.
 */

import type { DeviceSharingPayload } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { readJSONFile, writeJSON } from "./storage.js";

const sharingPath = () => foundryStatePath("system-account-sharing.json");

let sharedWith: string[] | undefined;

function names(payload: Partial<DeviceSharingPayload> | undefined): string[] {
  return Array.isArray(payload?.sharedWith)
    ? payload.sharedWith
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
}

/** The people the server last named, read from the state root once. */
export function systemAccountSharedWith(): string[] {
  sharedWith ??= names(readJSONFile<DeviceSharingPayload>(sharingPath()));
  return sharedWith;
}

/** device_sharing from the server. */
export function setSystemAccountSharing(
  payload: Partial<DeviceSharingPayload> | undefined,
): void {
  const next = names(payload);
  if (sharedWith && sharedWith.join("\n") === next.join("\n")) return;
  sharedWith = next;
  writeJSON(sharingPath(), { sharedWith: next });
}

/** The session note for a shared account; "" when nobody else uses it. */
export function sharedSystemAccountNote(): string {
  const people = systemAccountSharedWith();
  if (!people.length) return "";
  const named =
    people.length === 1
      ? people[0]
      : `${people.slice(0, -1).join(", ")} and ${people.at(-1)}`;
  return `- This computer account is shared: ${named} also use${people.length === 1 ? "s" : ""} it in Foundry, with the same files and the same Claude/Codex sign-ins. Nothing on this device is private to the person you work for; do not assume privacy.`;
}
