import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  DevicePlacement,
  DeviceProjection,
  PersonalAgentDeviceSettings,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import { listDevicePlacements } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { accountSharers, joinNames } from "../../lib/device-sharing";
import {
  SettingsCheck,
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

/** A computer without an entry may take work but not new projects. */
function deviceSettings(
  settings: PersonalAgentSettings,
  deviceId: string,
): PersonalAgentDeviceSettings {
  return (
    settings.devices.find((entry) => entry.deviceId === deviceId) ?? {
      deviceId,
      allowWork: true,
      allowCreate: false,
    }
  );
}

/** Which of the person's computers it may use, and where new projects go. */
export function PlacesSection({
  draft,
  change,
  owned,
  homeDeviceId,
  onOpenComputer,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  /** The person's own computers. */
  owned: DeviceProjection[];
  homeDeviceId: string;
  onOpenComputer: (deviceId: string) => void;
}) {
  const { t, i18n } = useTranslation("personalAgent");
  const [placements, setPlacements] = useState<DevicePlacement[]>([]);
  useEffect(() => {
    let cancelled = false;
    listDevicePlacements()
      .then((list) => {
        if (!cancelled) setPlacements(list);
      })
      .catch(() => {
        // The notes are a hint here; the computer's page shows any error.
      });
    return () => {
      cancelled = true;
    };
  }, [owned.length]);
  if (!owned.length)
    return <p className="fdy-pa-muted">{t("settings.places.none")}</p>;
  const home = owned.find((device) => device.id === homeDeviceId);

  function update(
    deviceId: string,
    patch: Partial<PersonalAgentDeviceSettings>,
  ) {
    const next = { ...deviceSettings(draft, deviceId), ...patch };
    const known = draft.devices.some((entry) => entry.deviceId === deviceId);
    change({
      devices: known
        ? draft.devices.map((entry) =>
            entry.deviceId === deviceId ? next : entry,
          )
        : [...draft.devices, next],
    });
  }

  return (
    <>
      <p className="fdy-pa-intro">{t("settings.places.intro")}</p>
      <ul className="fdy-pa-places">
        {owned.map((device) => {
          const entry = deviceSettings(draft, device.id);
          const folders = device.managedRoots ?? [];
          const notes = notesOf(
            placements.find((item) => item.deviceId === device.id),
          );
          const sharers = accountSharers(device);
          return (
            <li className="fdy-pa-place" key={device.id}>
              <div className="fdy-pa-inline">
                <strong>{device.label}</strong>
                <Badge
                  tone={device.status === "connected" ? "online" : "neutral"}
                >
                  {device.status === "connected"
                    ? t("settings.status.online")
                    : t("settings.status.offline")}
                </Badge>
              </div>
              {sharers.length ? (
                <span className="fdy-pa-muted">
                  {t("settings.places.shared", {
                    names: joinNames(sharers, i18n.language),
                  })}
                </span>
              ) : null}
              <SettingsCheck
                checked={entry.allowWork}
                label={t("settings.places.work")}
                onChange={(allowWork) => update(device.id, { allowWork })}
              />
              <SettingsCheck
                checked={entry.allowCreate}
                label={t("settings.places.create")}
                onChange={(allowCreate) => update(device.id, { allowCreate })}
              />
              <span className="fdy-pa-muted">
                {notes.length
                  ? t("settings.places.has", { notes: notes.join(" · ") })
                  : t("settings.places.hasNothing")}
              </span>
              <div className="fdy-pa-place-folder">
                <span className="fdy-pa-muted">
                  {folders.length
                    ? t("settings.places.folder", {
                        folders: folders.join(", "),
                      })
                    : t("settings.places.noFolder")}
                </span>
                <Button
                  onClick={() => onOpenComputer(device.id)}
                  size="sm"
                  variant="ghost"
                >
                  {t("settings.places.openComputer")}
                  <ArrowRight aria-hidden="true" size={14} />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <SettingsGroup>
        <SettingsField
          label={t("settings.places.preferred")}
          hint={t("settings.places.preferredHint")}
        >
          <SelectMenu
            ariaLabel={t("settings.places.preferred")}
            className="fdy-pa-select"
            onChange={(preferredDeviceId) => change({ preferredDeviceId })}
            options={[
              {
                value: "",
                label: t("settings.places.preferredHome", {
                  device: home?.label ?? homeDeviceId,
                }),
              },
              ...owned
                .filter((device) => device.id !== homeDeviceId)
                .map((device) => ({ value: device.id, label: device.label })),
            ]}
            value={draft.preferredDeviceId}
          />
        </SettingsField>
      </SettingsGroup>
    </>
  );
}

/** What the person noted about a computer, and whether it is always on. */
function notesOf(placement: DevicePlacement | undefined): string[] {
  if (!placement) return [];
  const notes = placement.labels.map((label) =>
    label.value ? `${label.key}: ${label.value}` : label.key,
  );
  if (
    !notes.includes("always-on") &&
    placement.facts.some((fact) => fact.key === "always-on")
  )
    notes.push("always-on");
  return notes;
}
