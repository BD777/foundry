import type { ToastTone } from "../../components/ui/toast";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorDevice,
  DeviceConnectorState,
  DeviceConnectorsView,
  ConnectorExtensionRepository,
  ExtensionReplyPayload,
} from "@bd777/foundry-protocol";
import {
  checkDeviceConnector,
  getDeviceConnectors,
  installDeviceExtension,
  removeDeviceExtension,
  signOutDeviceConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { errorText, relativeWhen } from "./account-format";
import { useConnectorInstalls } from "./connector-installs";
import { DeviceConnectorRow } from "./device-connector-row";
import {
  ExtensionInstallDialog,
  type ExtensionInstallTarget,
} from "./extension-install-dialog";
import { stateOf } from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { Skeleton, Spinner } from "../../components/ui/loading";
import { CopyButton } from "../../components/ui/copy-button";
import { TerminalBlock } from "../../components/ui/terminal-block";
import {
  connectorDescription,
  connectorName,
  offersSignIn,
} from "./connector-text";
import { DividedList } from "../../components/ui/divided-list";
import { Identity } from "../../components/ui/identity";
import { MutedText } from "../../components/ui/text";
import { SectionPanel } from "../../components/ui/section-panel";
import { CommandLine } from "../../components/ui/command-line";
import {
  connectorIntroClass,
  connectorIntroCopyClass,
  connectorStackClass,
  connectorTabClass,
} from "./connector-layout";

const offlineRecheckMs = 20_000;
const checkingRecheckMs = 2_000;
const installRecheckMs = 1_500;
/** How long the list is read again after an extension changed on a device. */
const extensionFollowMs = 12_000;

export interface DeviceHeldConnectorProps {
  /** The connector's kind in the catalog ("aws", or an extension's). */
  kind: string;
  onNotice: (message: string, tone?: ToastTone) => void;
  /** An extension changed on a device: the page's tabs may change too. */
  onCatalogChanged?: () => void;
}

/**
 * The Connectors page's tab for a device-held connector: the login stays
 * on each device, so the tab lists the person's devices, each with its
 * sign-in, the tool's version and what can be done there. Devices where the
 * connector cannot work (its requirement fails) are named, not offered.
 * Read on open (stale devices are read again) and after each action.
 */
export function DeviceHeldConnector({
  kind,
  onNotice,
  onCatalogChanged,
}: DeviceHeldConnectorProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState<DeviceConnectorsView>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<DeviceSignInTarget>();
  const [installing, setInstalling] = useState<ExtensionInstallTarget>();
  const [following, setFollowing] = useState(0);

  async function load(refresh: boolean) {
    try {
      setView(await getDeviceConnectors(refresh));
      setLoadError("");
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }

  useEffect(() => {
    void load(true);
  }, [kind]);

  // An offline device's actions wait for it: read the list again now and
  // then, so they turn on once it is back.
  const someOffline = view?.devices.some((device) => !device.online) ?? false;
  useEffect(() => {
    if (!someOffline) return;
    const timer = setInterval(() => void load(false), offlineRecheckMs);
    return () => clearInterval(timer);
  }, [someOffline]);

  // A device the server is still reading answers later, and an install
  // reports its progress: read the list again every few seconds meanwhile.
  const installs = useConnectorInstalls();
  const someInstalling = [...installs].some(
    ([key, install]) => install.state === "running" && key.endsWith(`:${kind}`),
  );
  const someChecking =
    view?.devices.some((device) => device.checking?.includes(kind)) ?? false;
  useEffect(() => {
    if (!someChecking && !someInstalling) return;
    const timer = setInterval(
      () => void load(false),
      someInstalling ? installRecheckMs : checkingRecheckMs,
    );
    return () => clearInterval(timer);
  }, [someChecking, someInstalling]);

  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => {
      void load(false);
      onCatalogChanged?.();
    }, installRecheckMs);
    const stop = setTimeout(() => setFollowing(0), extensionFollowMs);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [following]);

  const connector = view?.connectors.find((entry) => entry.kind === kind);

  function showState(deviceId: string, state: DeviceConnectorState) {
    setView(
      (current) =>
        current && {
          ...current,
          devices: current.devices.map((device) =>
            device.deviceId === deviceId
              ? {
                  ...device,
                  states: [
                    ...device.states.filter((entry) => entry.kind !== kind),
                    state,
                  ],
                }
              : device,
          ),
        },
    );
  }

  async function act(
    device: DeviceConnectorDevice,
    run: () => Promise<DeviceConnectorState>,
    notice: string,
  ) {
    setBusy(device.deviceId);
    try {
      showState(device.deviceId, await run());
      onNotice(notice);
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }), "error");
      void load(false);
    } finally {
      setBusy("");
    }
  }

  /**
   * An extension installed, updated or removed on a device: the device
   * reports its connectors at once; read the list until it shows.
   */
  function extensionChanged(deviceId: string, reply: ExtensionReplyPayload) {
    const device = view?.devices.find((entry) => entry.deviceId === deviceId);
    const extension = reply.extension?.name ?? connector?.extension?.name;
    onNotice(
      t(
        reply.action === "removed"
          ? "deviceHeld.extensionRemoved"
          : reply.action === "unchanged"
            ? "deviceHeld.extensionUnchanged"
            : reply.action === "updated"
              ? "deviceHeld.extensionUpdated"
              : "deviceHeld.extensionInstalled",
        { extension, device: device?.name ?? "" },
      ),
    );
    setFollowing(Date.now());
  }

  async function changeExtension(
    device: DeviceConnectorDevice,
    run: () => Promise<ExtensionReplyPayload>,
  ) {
    setBusy(device.deviceId);
    try {
      extensionChanged(device.deviceId, await run());
    } catch (cause) {
      onNotice(t("notices.failed", { error: errorText(cause) }), "error");
    } finally {
      setBusy("");
    }
  }

  async function checkAll() {
    if (!view) return;
    setChecking(true);
    await Promise.allSettled(
      view.devices
        .filter((device) => device.online)
        .map((device) =>
          checkDeviceConnector(device.deviceId, kind).then((state) =>
            showState(device.deviceId, state),
          ),
        ),
    );
    setChecking(false);
  }

  if (loadError)
    return (
      <Alert
        title={t("deviceHeld.loadFailed", { error: loadError })}
        tone="error"
      >
        <Button onClick={() => void load(true)} size="sm">
          {t("common:actions.retry")}
        </Button>
      </Alert>
    );
  if (!view)
    return <Skeleton label={t("deviceHeld.loading")} rows={2} variant="rows" />;
  if (!connector)
    return <Alert title={t("deviceHeld.unknown", { kind })} tone="error" />;

  // An extension's connector is on the devices where it is installed.
  const hasIt = (device: DeviceConnectorDevice) =>
    !connector.extension || (device.extensionKinds ?? []).includes(kind);
  const offered = view.devices.filter(
    (device) =>
      hasIt(device) && stateOf(device, kind)?.status !== "unavailable",
  );
  const notOffered = view.devices.filter(
    (device) =>
      hasIt(device) && stateOf(device, kind)?.status === "unavailable",
  );
  const without = view.devices.filter((device) => !hasIt(device));
  const name = connectorName(connector);
  const reminders = offered.filter((device) => {
    const status = stateOf(device, kind)?.status;
    return status === "expiring" || status === "expired";
  });
  const requirement = connector.requires
    ?.map((entry) => entry.label)
    .join(", ");
  const signIn = (device: DeviceConnectorDevice) =>
    setSigningIn({
      deviceId: device.deviceId,
      deviceName:
        view.devices.filter((d) => d.name === device.name).length > 1
          ? `${device.name} (${device.deviceId})`
          : device.name,
      kind,
      label: name,
      connector,
    });

  return (
    <div className={connectorTabClass}>
      <div className={connectorIntroClass}>
        <span className={connectorIntroCopyClass}>
          <MutedText>
            {connectorDescription(connector) ??
              t("deviceHeld.intro.default", { name })}
          </MutedText>
          {connector.extension ? (
            <MutedText as="small">
              {t("deviceHeld.fromExtension", {
                extension: connector.extension.name,
                version: connector.extension.version,
              })}
              {connector.extension.source
                ? ` ${t("deviceHeld.publishedIn", {
                    repository: repositoryLabel(connector.extension.source),
                  })}`
                : null}
            </MutedText>
          ) : null}
        </span>
        <Button
          aria-busy={checking}
          disabled={checking}
          onClick={() => void checkAll()}
          size="sm"
          variant="ghost"
        >
          {checking ? <Spinner /> : <RefreshCw size={14} />}
          {checking ? t("deviceHeld.checking") : t("deviceHeld.checkAll")}
        </Button>
      </div>
      {reminders.map((device) => {
        const state = stateOf(device, kind)!;
        return (
          <Alert
            key={device.deviceId}
            title={t(
              state.status === "expired"
                ? "deviceHeld.reminderExpired"
                : "deviceHeld.reminderExpiring",
              {
                name,
                device: device.name,
                when: relativeWhen(state.expiresAt),
              },
            )}
            tone="warning"
          >
            <Button
              disabled={!device.online || !offersSignIn(connector)}
              onClick={() => signIn(device)}
              size="sm"
              variant="primary"
            >
              {t("deviceHeld.signInAgain")}
            </Button>
          </Alert>
        );
      })}
      {offered.length === 0 ? (
        <SectionPanel>
          <EmptyState
            body={t(
              connector.extension
                ? "deviceHeld.emptyExtensionBody"
                : "deviceHeld.emptyBody",
              { name },
            )}
            title={t("deviceHeld.emptyTitle", { name })}
          />
        </SectionPanel>
      ) : (
        <SectionPanel>
          <DividedList density="cozy">
            {offered.map((device) => (
              <DeviceConnectorRow
                busy={busy === device.deviceId}
                connector={connector}
                distinguishDevice={
                  view.devices.filter((d) => d.name === device.name).length > 1
                }
                device={device}
                key={device.deviceId}
                onState={(next) => showState(device.deviceId, next)}
                onCheck={() =>
                  void act(
                    device,
                    () => checkDeviceConnector(device.deviceId, kind),
                    t("deviceHeld.checkedNotice", {
                      name,
                      device: device.name,
                    }),
                  )
                }
                onSignIn={() => signIn(device)}
                onUpdateExtension={(source) =>
                  void changeExtension(device, () =>
                    installDeviceExtension(device.deviceId, source),
                  )
                }
                onRemoveExtension={(extensionId) =>
                  void changeExtension(device, () =>
                    removeDeviceExtension(device.deviceId, extensionId),
                  )
                }
                onSignOut={() =>
                  void act(
                    device,
                    () => signOutDeviceConnector(device.deviceId, kind),
                    t("deviceHeld.signedOut", {
                      name,
                      device: device.name,
                    }),
                  )
                }
                state={stateOf(device, kind)}
              />
            ))}
          </DividedList>
        </SectionPanel>
      )}
      {notOffered.length > 0 ? (
        <MutedText>
          {t("deviceHeld.notOffered", {
            devices: notOffered.map((device) => device.name).join(", "),
            requirement,
            name,
          })}
        </MutedText>
      ) : null}
      {without.length > 0 ? (
        <section
          aria-label={t("deviceHeld.notInstalledTitle", {
            extension: connector.extension?.name ?? name,
          })}
          className={connectorStackClass}
        >
          <MutedText>
            {t(
              connector.extension?.source
                ? "deviceHeld.notInstalledInstall"
                : "deviceHeld.notInstalledOn",
              {
                devices: without.map((device) => device.name).join(", "),
                extension: connector.extension?.name ?? name,
              },
            )}
          </MutedText>
          {connector.extension?.source ? (
            <DividedList>
              {without.map((device) => (
                <li
                  className="fdy-xacc-binding-row flex min-w-0 items-start justify-between gap-3"
                  key={device.deviceId}
                >
                  <Identity as="span">
                    <strong>{device.name}</strong>
                    {!device.online ? (
                      <small>{t("deviceHeld.offlineInstall")}</small>
                    ) : null}
                  </Identity>
                  <Button
                    disabled={!device.online || Boolean(busy)}
                    onClick={() =>
                      setInstalling({
                        name: connector.extension!.name,
                        source: connector.extension!.source,
                        deviceId: device.deviceId,
                      })
                    }
                    size="sm"
                  >
                    {t("deviceHeld.installExtension", {
                      extension: connector.extension!.name,
                    })}
                  </Button>
                </li>
              ))}
            </DividedList>
          ) : connector.setup?.command ? (
            <CommandLine>
              <TerminalBlock
                lines={[
                  { id: "setup", prompt: "$", value: connector.setup.command },
                ]}
              />
              <CopyButton
                copiedLabel={t("setupSteps.signIn.copied")}
                label={t("setupSteps.signIn.copy", {
                  command: connector.setup.command,
                })}
                text={connector.setup.command}
              />
            </CommandLine>
          ) : null}
        </section>
      ) : null}
      <ExtensionInstallDialog
        devices={view.devices}
        key={
          installing
            ? `${installing.deviceId}:${installing.source?.git}`
            : "closed"
        }
        onClose={() => setInstalling(undefined)}
        onInstalled={(deviceId, reply) => {
          setInstalling(undefined);
          extensionChanged(deviceId, reply);
        }}
        target={installing}
      />
      <DeviceSignInDialog
        onClose={() => setSigningIn(undefined)}
        onSignedIn={(state) => {
          const target = signingIn;
          setSigningIn(undefined);
          if (target && state) showState(target.deviceId, state);
          else void load(false);
          if (target)
            onNotice(
              t("deviceHeld.signedInNotice", {
                name: target.label,
                device: target.deviceName,
              }),
            );
        }}
        target={signingIn}
      />
    </div>
  );
}

/** A git folder as a person reads it: host/owner/name, then the folder. */
function repositoryLabel(source: ConnectorExtensionRepository): string {
  const repository = source.git
    .replace(/^(https|ssh):\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "");
  return source.path ? `${repository}/${source.path}` : repository;
}
