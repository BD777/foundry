// The device owner's resource settings (ResourceSourceSettings) as this
// worker last heard them from the server (resource_settings), kept in the
// state folder so they hold across restarts. The worker enforces them
// itself: the compute provider runs nothing while remote commands are off,
// whatever a request says, and the compute detector reports the instance
// unready.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResourceSourceSettings } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../state-root.js";

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
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.current = next;
    return this.get();
  }
}

/**
 * Missing or unreadable settings are the defaults, as on the server: remote
 * commands on until the owner turns them off. Only an explicit false is off.
 */
function readSettings(path: string): ResourceSourceSettings {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ResourceSourceSettings> | null;
    return { allowRemoteCommands: value?.allowRemoteCommands !== false };
  } catch {
    return { allowRemoteCommands: true };
  }
}

/** This device's settings, shared by the detector and the provider. */
export const resourceSettings = new ResourceSettingsStore();
