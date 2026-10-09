import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceProjection,
  DeviceSkill,
  DeviceSkillRoot,
} from "@bd777/foundry-protocol";
import { listDeviceSkills } from "../../api";

interface DeviceSkillsState {
  deviceId?: string;
  skills: DeviceSkill[];
  roots: DeviceSkillRoot[];
  error?: string;
}

const empty: DeviceSkillsState = { skills: [], roots: [] };

/**
 * One owned device's scanned skills. Workspace data leaves them out (a
 * device can have hundreds), so they load here: again when the device's
 * `skillsVersion` moves (a scan finished or the catalog changed), and on
 * `reload` after the caller changes how its skills link to the catalog.
 */
export function useDeviceSkills(device: DeviceProjection | undefined) {
  const deviceId = device?.owned ? device.id : undefined;
  const version = device?.skillsVersion;
  const [state, setState] = useState<DeviceSkillsState>(empty);
  // Only the newest request may set state, so a slow answer for a device
  // the user already left cannot overwrite the current one.
  const latestRequest = useRef(0);

  const load = useCallback(async (id: string) => {
    const request = ++latestRequest.current;
    try {
      const snapshot = await listDeviceSkills(id);
      if (request !== latestRequest.current) return;
      setState({
        deviceId: id,
        skills: snapshot.skills ?? [],
        roots: snapshot.roots ?? [],
      });
    } catch (error) {
      if (request !== latestRequest.current) return;
      setState((current) => ({
        ...(current.deviceId === id ? current : empty),
        deviceId: id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    if (!deviceId) {
      latestRequest.current++;
      setState(empty);
      return;
    }
    void load(deviceId);
  }, [deviceId, version, load]);

  const reload = useCallback(async () => {
    if (deviceId) await load(deviceId);
  }, [deviceId, load]);

  // Until the new device's list arrives, show nothing rather than the
  // previous device's skills.
  const current = state.deviceId === deviceId ? state : empty;
  return { ...current, loaded: current !== empty, reload };
}
