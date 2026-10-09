import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { setSkillRepositorySource } from "../../api";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";

/** Workers older than this capability cannot read repositories. */
const repositoryFetchCapability = "skill_repository_fetch";

/** The server is the empty choice. */
const serverChoice = "";

/** Whether a device can read a repository for the library now. */
export function canReadWith(device: DeviceProjection): boolean {
  return (
    Boolean(device.owned) &&
    device.status === "connected" &&
    Boolean(device.capabilities?.includes(repositoryFetchCapability))
  );
}

/**
 * Who can read a repository: the Foundry server, or one of the person's own
 * devices (with its own git and npm settings). A device that is offline or
 * runs an old worker is listed, disabled, saying why.
 */
export function readerOptions(
  devices: DeviceProjection[],
  current?: { id: string; name: string },
): SelectMenuOption[] {
  const owned = devices.filter(
    (device) => device.owned && device.status !== "removed",
  );
  const others =
    current && !owned.some((device) => device.id === current.id)
      ? [
          {
            value: current.id,
            label: current.name,
            disabled: true,
            detail: i18n.t("skills:library.repo.readWithOthers"),
          },
        ]
      : [];
  return [
    {
      value: serverChoice,
      label: i18n.t("skills:library.repo.readWithServer"),
      detail: i18n.t("skills:library.repo.readWithServerDetail"),
    },
    ...others,
    ...owned.map((device) => ({
      value: device.id,
      label: device.label,
      disabled: !canReadWith(device),
      detail:
        device.status !== "connected"
          ? i18n.t("skills:library.repo.readWithOffline")
          : !device.capabilities?.includes(repositoryFetchCapability)
            ? i18n.t("skills:library.repo.readWithOutdated")
            : i18n.t("skills:library.repo.readWithDeviceDetail"),
    })),
  ];
}

/**
 * The "Read with" choice and, for an npm source, the registry it comes
 * from.
 */
export function RepositorySourceFields({
  devices,
  current,
  deviceId,
  registry,
  showRegistry,
  disabled,
  onDeviceChange,
  onRegistryChange,
}: {
  devices: DeviceProjection[];
  /** The device that reads it now, when it may be someone else's. */
  current?: { id: string; name: string };
  deviceId: string;
  registry: string;
  showRegistry: boolean;
  disabled: boolean;
  onDeviceChange: (deviceId: string) => void;
  onRegistryChange: (registry: string) => void;
}) {
  const { t } = useTranslation(["skills", "common"]);
  return (
    <div className="fdy-skill-repo-field-row">
      <div className="fdy-skill-repo-field">
        <span>{t("library.repo.readWith")}</span>
        <SelectMenu
          ariaLabel={t("library.repo.readWith")}
          disabled={disabled}
          insideDialog
          onChange={onDeviceChange}
          options={readerOptions(devices, current)}
          value={deviceId}
        />
      </div>
      {showRegistry ? (
        <label className="fdy-skill-repo-field">
          {t("library.repo.registry")}
          <TextInput
            disabled={disabled}
            onChange={(event) => onRegistryChange(event.currentTarget.value)}
            placeholder={
              deviceId
                ? t("library.repo.registryPlaceholderDevice")
                : t("library.repo.registryPlaceholderServer")
            }
            tone="boxed"
            value={registry}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Whether a source uses an npm registry: an npm package or npm tools. */
export function usesNpmRegistry(
  repo: Pick<SkillRepository, "url" | "declaredTools">,
): boolean {
  return (
    repo.url.startsWith("npm:") ||
    Boolean(repo.declaredTools?.some((tool) => tool.source === "npm"))
  );
}

/**
 * Changes where a followed repository is read; Foundry checks it there
 * right away.
 */
export function RepositorySourceDialog({
  repo,
  devices,
  onClose,
  onChanged,
}: {
  repo: SkillRepository;
  devices: DeviceProjection[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [deviceId, setDeviceId] = useState(repo.fetchDeviceId ?? "");
  const [registry, setRegistry] = useState(repo.registry ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = repo.name || repo.label;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setSkillRepositorySource(repo.id, { deviceId, registry });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-connection-assign-overlay" />
        <Dialog.Content className="fdy-connection-assign-dialog">
          <header className="fdy-connection-assign-header">
            <div>
              <Dialog.Title>
                {t("library.repo.sourceTitle", { label })}
              </Dialog.Title>
              <Dialog.Description>
                {t("library.repo.sourceDescription")}
              </Dialog.Description>
            </div>
          </header>
          <form
            aria-busy={busy}
            className="fdy-skill-promotion-body fdy-skill-repo-form"
            id="fdy-skill-repo-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <RepositorySourceFields
              deviceId={deviceId}
              current={
                repo.fetchDeviceId
                  ? {
                      id: repo.fetchDeviceId,
                      name: repo.fetchDeviceName || repo.fetchDeviceId,
                    }
                  : undefined
              }
              devices={devices}
              disabled={busy}
              onDeviceChange={setDeviceId}
              onRegistryChange={setRegistry}
              registry={registry}
              showRegistry={usesNpmRegistry(repo)}
            />
            {busy ? <p role="status">{t("library.repo.workingNote")}</p> : null}
            {error ? (
              <p role="alert" className="fdy-skill-error">
                {error}
              </p>
            ) : null}
          </form>
          <footer className="fdy-connection-assign-actions fdy-skill-dialog-actions">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              disabled={busy}
              form="fdy-skill-repo-source-form"
              type="submit"
              variant="primary"
            >
              {t("library.repo.saveSource")}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * "read by byte-dev" for a repository a device reads, saying when that
 * device is offline; empty for one the server reads.
 */
export function readByLabel(
  repo: Pick<
    SkillRepository,
    "fetchDeviceId" | "fetchDeviceName" | "fetchDeviceOnline"
  >,
): string {
  if (!repo.fetchDeviceId) return "";
  const device = repo.fetchDeviceName || repo.fetchDeviceId;
  return repo.fetchDeviceOnline
    ? i18n.t("skills:library.repo.readBy", { device })
    : i18n.t("skills:library.repo.readByOffline", { device });
}

/** A check that waits for the repository's device to come back online. */
export function waitingLabel(
  repo: Pick<
    SkillRepository,
    "fetchDeviceId" | "fetchDeviceName" | "fetchDeviceOnline" | "checkWaiting"
  >,
): string {
  if (!repo.fetchDeviceId || !repo.checkWaiting || repo.fetchDeviceOnline)
    return "";
  return i18n.t("skills:library.repo.waitingForDevice", {
    device: repo.fetchDeviceName || repo.fetchDeviceId,
  });
}
