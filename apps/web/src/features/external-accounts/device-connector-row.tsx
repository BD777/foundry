import type {
  ConnectorDescriptor,
  ConnectorExtensionRepository,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { relativeWhen } from "./account-format";
import {
  connectorInstallKey,
  installConnector,
  useConnectorInstalls,
} from "./connector-installs";
import { useInstallStep } from "./connector-setup-steps";
import { DeviceAuthorizationGroups } from "./device-authorization-groups";
import {
  deviceStatusLabel,
  deviceStatusTone,
  installNeed,
  newerVersion,
  newestState,
  sessionCheckText,
  signedInText,
  toolText,
} from "./device-held-format";
import {
  connectorName,
  localized,
  offersSignIn,
  signsOutHere,
} from "./connector-text";
import { Identity } from "../../components/ui/identity";
import { RowMain } from "../../components/ui/row-main";
import { Switch } from "../../components/ui/switch";

/**
 * One device on a device-held connector's tab: who is signed in there (or
 * why no one is), the tool's copy and version, its status and the one
 * action that moves it forward. Installing is a step inside the row. The
 * menu appears only when it holds more than checking again, which the tab's
 * header already offers; a page without that header (a workspace's
 * Connectors) shows Check again on the row instead.
 */
export function DeviceConnectorRow({
  connector,
  distinguishDevice,
  device,
  state: shown,
  busy,
  onState,
  onCheck,
  onSignIn,
  onSignOut,
  onUpdateExtension,
  onRemoveExtension,
  onAutoUpdateExtension,
  showCheck = false,
  note,
  children,
}: {
  connector: ConnectorDescriptor;
  distinguishDevice: boolean;
  device: DeviceConnectorDevice;
  state?: DeviceConnectorState;
  busy: boolean;
  onState: (state: DeviceConnectorState) => void;
  onCheck: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  /** Installs the extension again from its source (an update). */
  onUpdateExtension?: (source: ConnectorExtensionRepository) => void;
  onRemoveExtension?: (extensionId: string) => void;
  /** Changes automatic git-source updates for this extension. */
  onAutoUpdateExtension?: (enabled: boolean) => void;
  showCheck?: boolean;
  /** A line under who is signed in, about what the page is for. */
  note?: ReactNode;
  /** The page's own controls for this device, under the row. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("externalAccounts");
  const activity = useConnectorInstalls().get(
    connectorInstallKey(device.deviceId, connector.kind),
  );
  // An install that finished while this tab was closed has the newer reading.
  const state = newestState(shown, activity?.result);
  const installing = activity?.state === "running";
  const locked = busy || installing;
  const reachable = device.online;
  const status = state?.status;
  const settingUp = Boolean(installNeed(connector, state)) || installing;
  // Installing is the row's own step: its words under the device, its one
  // action where the row's other actions are.
  const installStep = useInstallStep(connector, device, state, onState);
  // The server is reading it now; what shows is the last reading meanwhile.
  const checking = device.checking?.includes(connector.kind) ?? false;
  const name = connectorName(connector);
  // Who is signed in comes first; an install step adds its own words
  // (never "not installed": the badge says that).
  const installTitle =
    installStep && installStep.copy !== "missing" ? installStep.title : "";
  const summary = state?.signedIn
    ? signedInText(state)
    : installStep
      ? installTitle
      : !state
        ? t(checking ? "deviceHeld.checkingNow" : "deviceHeld.notRead")
        : state.signedIn
          ? signedInText(state)
          : status === "not_installed"
            ? t("deviceHeld.notInstalled", { name })
            : status === "error"
              ? t("deviceHeld.readFailed", { detail: state.statusDetail ?? "" })
              : t("deviceHeld.notSignedIn");
  const where = !device.online
    ? t(state ? "deviceHeld.offline" : "deviceHeld.offlineUnknown", {
        when: state ? relativeWhen(state.checkedAt) : "",
      })
    : state && checking
      ? t("deviceHeld.checkingSince", { when: relativeWhen(state.checkedAt) })
      : state && state.installed
        ? toolText(connector, state)
        : state
          ? t("deviceHeld.checkedAt", { when: relativeWhen(state.checkedAt) })
          : "";
  const install = () =>
    void installConnector(device.deviceId, connector.kind).then((next) => {
      if (next) onState(next);
    });
  const upgrade =
    state?.installSource === "foundry" &&
    (connector.tool.source === "installer" ||
      newerVersion(state.latestVersion, state.version));
  // The extension this connector comes from, as this device installed it.
  const extension = connector.extension
    ? device.extensions?.find((entry) => entry.id === connector.extension!.id)
    : undefined;
  const extensionUpdate =
    reachable &&
    onUpdateExtension &&
    extension?.source &&
    extension.commit &&
    extension.latestCommit &&
    extension.latestCommit !== extension.commit
      ? extension.source
      : undefined;
  const repeat = connector.signIn?.repeat;
  const extra: RowMenuItem[] = [
    ...(reachable && repeat && state?.signedIn && offersSignIn(connector)
      ? [
          {
            key: "sign-in-again",
            label: localized(repeat.label, repeat.labels),
            onSelect: onSignIn,
          },
        ]
      : []),
    ...(reachable && upgrade && connector.tool.source !== "device"
      ? [
          {
            key: "upgrade",
            label:
              connector.tool.source === "npm"
                ? t("deviceHeld.upgrade", { version: state?.latestVersion })
                : t("deviceHeld.update", { name }),
            onSelect: install,
          },
        ]
      : []),
    ...(reachable && signsOutHere(connector) && state?.signedIn
      ? [
          {
            key: "sign-out",
            label: t("deviceHeld.signOut"),
            onSelect: onSignOut,
            confirm: {
              title: t("deviceHeld.signOutTitle", {
                name,
                device: device.name,
              }),
              body: t("deviceHeld.signOutBody", { name }),
              action: t("deviceHeld.signOut"),
            },
          },
        ]
      : []),
    ...(reachable && onRemoveExtension && connector.extension
      ? [
          {
            key: "remove-extension",
            label: t("deviceHeld.removeExtension", {
              extension: connector.extension.name,
            }),
            tone: "danger" as const,
            onSelect: () => onRemoveExtension(connector.extension!.id),
            confirm: {
              title: t("deviceHeld.removeExtensionTitle", {
                extension: connector.extension.name,
                device: device.name,
              }),
              body: t("deviceHeld.removeExtensionBody", {
                extension: connector.extension.name,
              }),
              action: t("deviceHeld.removeExtensionAction"),
            },
          },
        ]
      : []),
  ];
  const items: RowMenuItem[] =
    extra.length > 0 && reachable && !showCheck
      ? [
          {
            key: "check",
            label: t("deviceHeld.checkAgain"),
            onSelect: onCheck,
          },
          ...extra,
        ]
      : extra;
  const primary =
    !reachable || !state || !offersSignIn(connector) || settingUp
      ? undefined
      : status === "signed_out" || status === "expired"
        ? { label: t("deviceHeld.signIn"), run: onSignIn }
        : status === "expiring"
          ? { label: t("deviceHeld.signInAgain"), run: onSignIn }
          : undefined;
  return (
    <li
      className="fdy-xacc-row fdy-xacc-device-row grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1"
      data-status={status ?? "unknown"}
    >
      <RowMain className="max-[520px]:flex-wrap">
        <Identity>
          <strong>{device.name}</strong>
          {distinguishDevice ? <small>{device.deviceId}</small> : null}
          {summary ? <span>{summary}</span> : null}
          {note ? <span>{note}</span> : null}
          {state?.signedIn && installTitle ? <span>{installTitle}</span> : null}
          {state
            ? sessionCheckText(state).map((line) => (
                <span
                  key={line.text}
                  data-state={line.problem ? "failed" : undefined}
                  className="data-[state=failed]:text-error-text"
                >
                  {line.text}
                </span>
              ))
            : null}
          {installStep?.detail ? (
            <span
              className="fdy-xacc-install-detail data-[state=failed]:text-error-text"
              data-state={installStep.state}
            >
              {installStep.detail}
            </span>
          ) : null}
          {state?.signedIn && connector.provides?.modelAccess ? (
            <small>{t("deviceHeld.givesModels", { name })}</small>
          ) : null}
          {where ? (
            <small aria-busy={checking || undefined}>{where}</small>
          ) : null}
          {extensionUpdate ? (
            <small>
              {t("deviceHeld.extensionUpdateAvailable", {
                extension: connector.extension!.name,
                commit: extension!.latestCommit!.slice(0, 7),
              })}
            </small>
          ) : null}
        </Identity>
        <span className="inline-flex flex-none flex-wrap items-center justify-end gap-2 max-[520px]:min-w-0 max-[520px]:flex-[1_1_100%] max-[520px]:justify-start">
          {status ? (
            <Badge tone={deviceStatusTone(status)}>
              {deviceStatusLabel(status, connector)}
            </Badge>
          ) : null}
          {installStep?.action ?? null}
          {extensionUpdate ? (
            <Button
              disabled={locked}
              onClick={() => onUpdateExtension!(extensionUpdate)}
              size="sm"
            >
              {t("deviceHeld.updateExtension", {
                extension: connector.extension!.name,
              })}
            </Button>
          ) : null}
          {primary ? (
            <Button
              disabled={locked}
              onClick={primary.run}
              size="sm"
              variant="primary"
            >
              {primary.label}
            </Button>
          ) : null}
          {reachable && (showCheck || !state) ? (
            <Button
              disabled={locked}
              onClick={onCheck}
              size="sm"
              variant={state ? "ghost" : "secondary"}
            >
              {t("deviceHeld.checkAgain")}
            </Button>
          ) : null}
          {items.length > 0 ? (
            <RowMenu
              disabled={locked}
              items={items}
              label={t("actions.more", { name: device.name })}
            />
          ) : null}
        </span>
      </RowMain>
      {extension &&
      (extension.source || extension.bundled || extension.bundledVersion) ? (
        <div className="flex min-w-0 items-center justify-between gap-3 px-1 text-xs text-ink-muted">
          <span className="min-w-0">
            {extension.bundledVersion && !extension.bundled
              ? t("deviceHeld.localNewerThanBundled", {
                  local: extension.version,
                  bundled: extension.bundledVersion,
                })
              : extension.bundled
                ? t("deviceHeld.updatesWithWorker")
                : t("deviceHeld.autoUpdate")}
          </span>
          {extension.bundled ? (
            <Badge tone="neutral">{t("deviceHeld.bundled")}</Badge>
          ) : (
            <span className="flex items-center gap-2">
              <small>
                {extension.autoUpdate === false
                  ? t("deviceHeld.autoUpdateOff")
                  : t("deviceHeld.autoUpdateOn")}
              </small>
              <Switch
                aria-label={t("deviceHeld.autoUpdate")}
                checked={extension.autoUpdate !== false}
                disabled={locked || !onAutoUpdateExtension}
                onCheckedChange={onAutoUpdateExtension}
              />
            </span>
          )}
        </div>
      ) : null}
      {children}
      <DeviceAuthorizationGroups
        connector={connector}
        device={device}
        state={state}
        disabled={locked}
        onState={onState}
      />
    </li>
  );
}
