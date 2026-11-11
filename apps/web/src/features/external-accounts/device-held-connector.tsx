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
  setDeviceExtensionAutoUpdate,
  signOutDeviceConnector,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { errorText, relativeWhen } from "./account-format";
import { useConnectorInstalls } from "./connector-installs";
import { DeviceConnectorRow } from "./device-connector-row";
import { DeviceConnectorConfiguration } from "./device-connector-configuration";
import {
  ExtensionInstallDialog,
  type ExtensionInstallTarget,
} from "./extension-install-dialog";
import { stateOf } from "./device-held-format";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { Skeleton } from "../../components/ui/loading";
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
import { ConnectorPermissionsNote } from "./connector-permissions-note";
import { SectionHead, SectionPanel } from "../../components/ui/section-panel";
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
/** A reading older than this the server reads again on refresh (connectorStaleAfter). */
const staleAfterMs = 2 * 60_000;

/**
 * While a refresh is on its way, the online devices it reads again (no
 * reading of the kind yet, or one older than the server's stale bound) show
 * as being checked beside their last reading, never as verified.
 */
export function markRefreshing(
  view: DeviceConnectorsView,
  kind: string,
  now = Date.now(),
): DeviceConnectorsView {
  return {
    ...view,
    devices: view.devices.map((device) => {
      if (!device.online || device.checking?.includes(kind)) return device;
      const state = device.states.find((entry) => entry.kind === kind);
      if (state && now - Date.parse(state.checkedAt) < staleAfterMs)
        return device;
      return { ...device, checking: [...(device.checking ?? []), kind] };
    }),
  };
}

export interface DeviceHeldConnectorProps {
  /** The connector's kind in the catalog ("aws", or an extension's). */
  kind: string;
  onNotice: (message: string, tone?: ToastTone) => void;
  /** An extension changed on a device: the page's tabs may change too. */
  onCatalogChanged?: () => void;
  /**
   * The page's last reading of the person's devices (it covers every
   * device-held connector), drawn at once while stale devices are read
   * again; each new reading goes back through onView.
   */
  lastView?: DeviceConnectorsView;
  onView?: (view: DeviceConnectorsView) => void;
}

/**
 * The Connectors page's tab for a device-held connector: the login stays
 * on each device, so the tab lists the person's devices, each with its
 * sign-in, the tool's version and what can be done there. Devices where the
 * connector cannot work (its requirement fails) are named, not offered.
 * It draws the page's last reading at once, then reads stale devices again
 * in the background, those rows saying they are being checked meanwhile;
 * and reads again after each action.
 */
export function DeviceHeldConnector({
  kind,
  onNotice,
  onCatalogChanged,
  lastView,
  onView,
}: DeviceHeldConnectorProps) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const [view, setView] = useState(lastView);
  const [loadError, setLoadError] = useState("");
  // The background read of stale devices is on its way.
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<DeviceSignInTarget>();
  const [installing, setInstalling] = useState<ExtensionInstallTarget>();
  const [following, setFollowing] = useState(0);

  async function load(refresh: boolean): Promise<boolean> {
    try {
      setView(await getDeviceConnectors(refresh));
      setLoadError("");
      return true;
    } catch (cause) {
      setLoadError(errorText(cause));
      return false;
    }
  }

  useEffect(() => {
    if (view) onView?.(view);
  }, [view]);

  // The last reading first (the page's, or the server's stored one, which
  // answers at once), then the stale devices read again, which can take the
  // server's whole wait when a device's tool is slow to answer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!view && !(await load(false))) return;
      if (cancelled) return;
      setRefreshing(true);
      await load(true);
      if (!cancelled) setRefreshing(false);
    })();
    return () => {
      cancelled = true;
    };
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
  const shown = refreshing ? markRefreshing(view, kind) : view;

  // An extension's connector is on the devices where it is installed.
  const hasIt = (device: DeviceConnectorDevice) =>
    !connector.extension || (device.extensionKinds ?? []).includes(kind);
  const offered = shown.devices.filter(
    (device) =>
      hasIt(device) && stateOf(device, kind)?.status !== "unavailable",
  );
  const notOffered = shown.devices.filter(
    (device) =>
      hasIt(device) && stateOf(device, kind)?.status === "unavailable",
  );
  const without = shown.devices.filter((device) => !hasIt(device));
  const name = connectorName(connector);
  const bundledEmptyInstall =
    connector.extension?.bundled && offered.length === 0 && without.length > 0;
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
  const installBlocked = (
    device: DeviceConnectorDevice,
  ): string | undefined => {
    if (!device.online) return t("deviceHeld.offlineInstall");
    const state = stateOf(device, kind);
    if (state?.status === "unavailable")
      return (
        state.statusDetail ?? requirement ?? t("deviceHeld.unavailableInstall")
      );
    return undefined;
  };
  const installLabel = () =>
    connector.extension?.bundled
      ? t("deviceHeld.installBundled")
      : t("deviceHeld.installExtension", {
          extension: connector.extension?.name ?? name,
        });
  const install = (device: DeviceConnectorDevice) =>
    connector.extension?.source
      ? setInstalling({
          name: connector.extension.name,
          source: connector.extension.source,
          deviceId: device.deviceId,
        })
      : void changeExtension(device, () =>
          installDeviceExtension(device.deviceId, {
            bundledExtensionId: connector.extension!.id,
          }),
        );

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
              {t(
                connector.extension.source
                  ? "deviceHeld.extensionSourceGit"
                  : connector.extension.bundled
                    ? "deviceHeld.extensionSourceBundled"
                    : "deviceHeld.extensionSourceLocal",
                {
                  extension: connector.extension.name,
                  version: connector.extension.version,
                  repository: connector.extension.source
                    ? repositoryLabel(connector.extension.source)
                    : "",
                },
              )}
            </MutedText>
          ) : null}
          <ConnectorPermissionsNote connector={connector} />
        </span>
        <Button
          busy={checking || refreshing}
          onClick={() => void checkAll()}
          size="sm"
          variant="ghost"
        >
          {checking || refreshing ? null : <RefreshCw size={14} />}
          {checking || refreshing
            ? t("deviceHeld.checking")
            : t("deviceHeld.checkAll")}
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
        bundledEmptyInstall ? (
          <SectionPanel>
            <SectionHead
              title={t("deviceHeld.installBundledTitle", {
                extension: connector.extension!.name,
              })}
            />
            <DividedList density="cozy">
              {without.map((device) => {
                const blocked = installBlocked(device);
                return (
                  <li
                    className="fdy-xacc-binding-row flex min-w-0 items-center justify-between gap-3 max-[520px]:flex-wrap max-[520px]:items-start"
                    key={device.deviceId}
                  >
                    <Identity as="span">
                      <strong>{device.name}</strong>
                      {blocked ? <small>{blocked}</small> : null}
                    </Identity>
                    <Button
                      disabled={Boolean(blocked) || Boolean(busy)}
                      onClick={() => install(device)}
                      size="sm"
                    >
                      {installLabel()}
                    </Button>
                  </li>
                );
              })}
            </DividedList>
          </SectionPanel>
        ) : (
          <SectionPanel>
            <EmptyState
              body={t(
                connector.extension
                  ? connector.extension.source
                    ? "deviceHeld.emptyExtensionBody"
                    : "deviceHeld.emptyExtensionAddBody"
                  : "deviceHeld.emptyBody",
                { name },
              )}
              title={t("deviceHeld.emptyTitle", { name })}
            />
          </SectionPanel>
        )
      ) : (
        <SectionPanel aria-busy={refreshing || undefined}>
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
                    installDeviceExtension(device.deviceId, { source }),
                  )
                }
                onRemoveExtension={(extensionId) =>
                  void changeExtension(device, () =>
                    removeDeviceExtension(device.deviceId, extensionId),
                  )
                }
                onAutoUpdateExtension={(enabled) =>
                  void changeExtension(device, () =>
                    setDeviceExtensionAutoUpdate(
                      device.deviceId,
                      connector.extension!.id,
                      enabled,
                    ),
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
              >
                {kind === "aws" && stateOf(device, kind)?.installed ? (
                  <DeviceConnectorConfiguration
                    deviceId={device.deviceId}
                    disabled={busy === device.deviceId}
                    kind={kind}
                    onSaved={() =>
                      onNotice(
                        t("deviceHeld.configuration.regionSaved", {
                          device: device.name,
                        }),
                      )
                    }
                    onState={(next) => showState(device.deviceId, next)}
                    state={stateOf(device, kind)!}
                  />
                ) : null}
              </DeviceConnectorRow>
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
      {without.length > 0 && !bundledEmptyInstall ? (
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
                : connector.extension?.bundled
                  ? "deviceHeld.bundledNotInstalled"
                  : "deviceHeld.notInstalledOn",
              {
                devices: without.map((device) => device.name).join(", "),
                extension: connector.extension?.name ?? name,
              },
            )}
          </MutedText>
          {connector.extension?.source || connector.extension?.bundled ? (
            <DividedList>
              {without.map((device) => {
                const blocked = installBlocked(device);
                return (
                  <li
                    className="fdy-xacc-binding-row flex min-w-0 items-center justify-between gap-3 max-[520px]:flex-wrap max-[520px]:items-start"
                    key={device.deviceId}
                  >
                    <Identity as="span">
                      <strong>{device.name}</strong>
                      {blocked ? <small>{blocked}</small> : null}
                    </Identity>
                    <Button
                      disabled={Boolean(blocked) || Boolean(busy)}
                      onClick={() => install(device)}
                      size="sm"
                    >
                      {installLabel()}
                    </Button>
                  </li>
                );
              })}
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
