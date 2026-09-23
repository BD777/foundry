import { navigateAppRoute } from "../app/navigation";

/**
 * Inward navigation surface for feature code: opens the existing
 * Devices → device → Agents management page through the shell's normal
 * popstate contract (no new route). Features cannot import the app layer
 * directly, so this lib wrapper is the allowed entry point.
 */
export function navigateToDeviceAgents(deviceId: string): void {
  navigateAppRoute({
    deviceSection: "agents",
    selectedDeviceId: deviceId,
    view: "devices",
  });
}
