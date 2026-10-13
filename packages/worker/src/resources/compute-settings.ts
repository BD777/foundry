// The device owner's resource settings (ResourceSourceSettings) as this
// worker last heard them from the server (resource_settings), kept in the
// state folder so they hold across restarts. The worker enforces them
// itself: the compute provider runs nothing while remote commands are off,
// whatever a request says, and the compute detector reports the instance
// unready.

import type { ResourceSourceSettings } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../state-root.js";
import { tryReadJSONFile, writePrivateJSONAtomic } from "../storage.js";

export class ResourceSettingsStore {
  private current: ResourceSourceSettings;

  constructor(
    private readonly path: string = foundryStatePath(
      "resources",
      "settings.json",
    ),
  ) {
    this.current = readSettings(path);
  }

  get(): ResourceSourceSettings {
    return { ...this.current };
  }

  /** Keeps what the server sent and answers what is now enforced. */
  set(
    settings: Partial<ResourceSourceSettings> | undefined,
  ): ResourceSourceSettings {
    const next: ResourceSourceSettings = {
      allowRemoteCommands: settings?.allowRemoteCommands === true,
    };
    writePrivateJSONAtomic(this.path, next);
    this.current = next;
    return this.get();
  }
}

/**
 * Missing or unreadable settings are the defaults, as on the server: remote
 * commands on until the owner turns them off. Only an explicit false is off.
 */
function readSettings(path: string): ResourceSourceSettings {
  const value = tryReadJSONFile<Partial<ResourceSourceSettings> | null>(path);
  return { allowRemoteCommands: value?.allowRemoteCommands !== false };
}

/** This device's settings, shared by the detector and the provider. */
export const resourceSettings = new ResourceSettingsStore();
