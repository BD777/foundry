import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  PersonalAgent,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { isRemovedDevice } from "../../lib/devices";

/** Configured locations stay explicit when their device is removed. They are
 * historical references, never selectable permissions or implicit fallbacks. */
export function DeviceReferences({
  agent,
  draft,
  devices,
}: {
  agent: PersonalAgent;
  draft: PersonalAgentSettings;
  devices: DeviceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const refs = new Map<string, string[]>();
  function add(id: string | undefined, source: string) {
    if (!id) return;
    const device = devices.find((d) => d.id === id);
    if (device && !isRemovedDevice(device)) return;
    refs.set(id, [...(refs.get(id) ?? []), source]);
  }
  add(agent.homeDeviceId, t("settings.status.home"));
  add(draft.preferredDeviceId, t("settings.places.preferred"));

  add(draft.runDefault?.deviceId, t("settings.sections.models"));
  for (const [role, preference] of Object.entries(draft.roleOverrides ?? {})) {
    add(preference.deviceId, role);
    for (const fallback of preference.fallbacks ?? [])
      add(fallback.deviceId, role);
  }
  for (const fallback of draft.runDefault?.fallbacks ?? [])
    add(fallback.deviceId, t("settings.sections.models"));
  if (!refs.size) return null;
  return (
    <Alert tone="warning" title={t("settings.devices.unavailable")}>
      <p>{t("settings.devices.removedHint")}</p>
      <ul>
        {[...refs].map(([id, sources]) => (
          <li key={id}>
            {devices.find((d) => d.id === id)?.label ?? id} ·{" "}
            {[...new Set(sources)].join(" · ")}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** Lifecycle refreshes revoke a grant without becoming an unsaved user edit. */
export function currentDeviceGrants(
  settings: PersonalAgentSettings,
  devices: DeviceProjection[],
): PersonalAgentSettings {
  const removed = new Set(devices.filter(isRemovedDevice).map((d) => d.id));
  return settings.devices.some((entry) => removed.has(entry.deviceId))
    ? {
        ...settings,
        devices: settings.devices.filter(
          (entry) => !removed.has(entry.deviceId),
        ),
      }
    : settings;
}
