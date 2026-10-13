import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, KeyRound, LoaderCircle, Settings } from "lucide-react";
import {
  cuaDriverBackend,
  type ResourceBackend,
  type ResourceBackendInstallResult,
  type ResourceInstance,
} from "@bd777/foundry-protocol";
import { installResourceBackend, refreshDeviceResources } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";
import {
  backendLabel,
  leadingBackendsFirst,
  missingText,
  readinessText,
} from "./resource-groups";

/** Details the cua-driver detector adds about its permission checks. */
export const cuaDriverCheckDetailKeys = new Set([
  "grantRun",
  "grantOutput",
  "permissionCheck",
]);

/** The System Settings pane for each grant cua-driver may be missing. */
const settingsPanes = [
  { code: "tcc_accessibility", pane: "accessibility" },
  { code: "tcc_screen_recording", pane: "screen-recording" },
] as const;

const accessCodes = new Set([
  "cua_driver_not_running",
  "tcc_accessibility",
  "tcc_screen_recording",
]);

/** Each backend of an instance with its readiness in words. */
export function ResourceBackends({
  instance,
  setup,
  onChanged,
}: {
  instance: ResourceInstance;
  /** The device's owner may install and grant its backends now. */
  setup: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  if (!instance.backends.length) return null;
  // Once one backend serves the resource, the others' gaps are side notes.
  const served = instance.backends.some((backend) => backend.readiness.ready);
  return (
    <ul className="fdy-res-backends">
      {leadingBackendsFirst(instance.backends).map((backend) => (
        <li key={backend.id}>
          <p
            className="fdy-res-meta"
            data-ready={
              backend.readiness.ready ? "true" : served ? "optional" : "false"
            }
          >
            {t("backendLine", {
              backend: backendLabel(backend),
              readiness: readinessText(backend.readiness),
            })}
          </p>
          {setup && backend.id === cuaDriverBackend ? (
            <CuaDriverSetup
              backend={backend}
              details={instance.details ?? {}}
              device={instance.source}
              onChanged={onChanged}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Gets cua-driver going on a Mac, only when the person asks: its official
 * installer, then the macOS grants it needs.
 */
function CuaDriverSetup({
  backend,
  details,
  device,
  onChanged,
}: {
  backend: ResourceBackend;
  details: Record<string, string>;
  device: ResourceInstance["source"];
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const action = useResourceAction<
    "install" | "access" | (typeof settingsPanes)[number]["pane"]
  >();
  const [installed, setInstalled] = useState<ResourceBackendInstallResult>();
  const [confirming, setConfirming] = useState(false);
  const missing = backend.readiness.missing ?? [];
  const canInstall = missing.includes("cua_driver_not_installed");
  const canRequest =
    !canInstall &&
    !missing.includes("cua_driver_awaiting_approval") &&
    missing.some((code) => accessCodes.has(code));
  const panes = canInstall
    ? []
    : settingsPanes.filter(({ code }) => missing.includes(code));
  const check = cuaDriverCheck(details, backend.readiness.ready);
  // "Approve each prompt…" and the like are moot once access is verified.
  const notice =
    backend.readiness.ready || details.grantRun === "verified"
      ? ""
      : action.notice;
  if (
    !canInstall &&
    !canRequest &&
    !panes.length &&
    !check &&
    !installed &&
    !notice &&
    !action.error
  )
    return null;

  const install = () =>
    void action.run("install", async () => {
      setInstalled(undefined);
      const result = await installResourceBackend(device.id, cuaDriverBackend);
      setInstalled(result);
      onChanged();
      return "";
    });
  const requestAccess = () =>
    void action.run("access", async () => {
      await refreshDeviceResources(device.id, cuaDriverBackend);
      onChanged();
      return t("access.requested", { device: device.label });
    });

  const openSettings = (pane: (typeof settingsPanes)[number]["pane"]) =>
    void action.run(pane, async () => {
      await refreshDeviceResources(device.id, `${cuaDriverBackend}:${pane}`);
      onChanged();
      return t(`access.panes.${pane}.opened`, { device: device.label });
    });

  return (
    <div className="fdy-res-setup" aria-busy={Boolean(action.running)}>
      {canInstall || canRequest || panes.length ? (
        <div className="fdy-res-actions">
          {canInstall ? (
            <Button
              aria-busy={action.running === "install"}
              disabled={Boolean(action.running)}
              size="sm"
              variant="secondary"
              onClick={() => setConfirming(true)}
            >
              {action.running === "install" ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="fdy-spin"
                  size={14}
                />
              ) : (
                <Download aria-hidden="true" size={14} />
              )}
              {action.running === "install"
                ? t("install.installing")
                : t("install.action")}
            </Button>
          ) : null}
          {canRequest ? (
            <Button
              aria-busy={action.running === "access"}
              disabled={Boolean(action.running)}
              size="sm"
              variant="secondary"
              onClick={requestAccess}
            >
              <KeyRound aria-hidden="true" size={14} />
              {action.running === "access"
                ? t("access.requesting", { device: device.label })
                : t("access.action")}
            </Button>
          ) : null}
          {panes.map(({ pane }) => (
            <Button
              aria-busy={action.running === pane}
              disabled={Boolean(action.running)}
              key={pane}
              size="sm"
              variant="ghost"
              onClick={() => openSettings(pane)}
            >
              <Settings aria-hidden="true" size={14} />
              {action.running === pane
                ? t("access.opening", { device: device.label })
                : t(`access.panes.${pane}.action`)}
            </Button>
          ))}
        </div>
      ) : null}
      {panes.length ? (
        <ul className="fdy-res-steps">
          {panes.map(({ pane }) => (
            <li key={pane}>{t(`access.panes.${pane}.hint`)}</li>
          ))}
        </ul>
      ) : null}
      {check ? (
        check.tone === "error" ? (
          <Alert
            className="fdy-res-install-result"
            details={
              check.output ? (
                <figure className="fdy-res-output">
                  <figcaption>{t("access.check.output")}</figcaption>
                  <pre>{check.output}</pre>
                </figure>
              ) : undefined
            }
            title={t(check.key, { device: device.label })}
            tone="error"
          >
            <p>{t("access.check.retry")}</p>
          </Alert>
        ) : (
          <p className="fdy-res-status" role="status">
            {t(check.key, { device: device.label })}
          </p>
        )
      ) : null}
      {action.running === "install" ? (
        <p className="fdy-res-status" role="status">
          {t("install.wait", { device: device.label })}
        </p>
      ) : null}
      {installed ? <InstallOutcome device={device} result={installed} /> : null}
      {notice ? (
        <p className="fdy-res-status" role="status">
          {notice}
        </p>
      ) : null}
      {action.error ? (
        <p className="fdy-res-error" role="alert">
          {action.error}
        </p>
      ) : null}
      {confirming ? (
        <ResourceConfirmDialog
          confirmLabel={t("install.confirm")}
          description={t("install.description")}
          items={[
            t("install.items.source", { device: device.label }),
            t("install.items.telemetry"),
            t("install.items.license"),
            t("install.items.grants", { device: device.label }),
          ]}
          title={t("install.title", { device: device.label })}
          onClose={() => setConfirming(false)}
          onConfirm={install}
        />
      ) : null}
    </div>
  );
}

type CheckKey =
  | "access.check.waiting"
  | "access.check.live"
  | "access.check.verified"
  | "access.check.failed"
  | "access.check.timedOut";

/**
 * What the last `cua-driver permissions grant` (Request access, or the
 * live recheck) is doing or did, as the detector reported it.
 */
function cuaDriverCheck(
  details: Record<string, string>,
  ready: boolean,
):
  | { key: CheckKey; tone: "status" }
  | { key: CheckKey; tone: "error"; output: string }
  | undefined {
  const live = details.permissionCheck === "live";
  switch (details.grantRun) {
    case "waiting":
      return { key: "access.check.waiting", tone: "status" };
    case "verified":
      return ready
        ? { key: "access.check.verified", tone: "status" }
        : live
          ? { key: "access.check.live", tone: "status" }
          : undefined;
    case "failed":
    case "timed_out":
      return {
        key:
          details.grantRun === "failed"
            ? "access.check.failed"
            : "access.check.timedOut",
        tone: "error",
        output: details.grantOutput ?? "",
      };
    default:
      return live ? { key: "access.check.live", tone: "status" } : undefined;
  }
}

function InstallOutcome({
  device,
  result,
}: {
  device: ResourceInstance["source"];
  result: ResourceBackendInstallResult;
}) {
  const { t } = useTranslation("resources");
  const missing = result.missing ?? [];
  return (
    <Alert
      className="fdy-res-install-result"
      details={
        result.output ? (
          <figure className="fdy-res-output">
            <figcaption>{t("install.output")}</figcaption>
            <pre>{result.output}</pre>
          </figure>
        ) : undefined
      }
      title={t(result.ok ? "install.done" : "install.failed", {
        device: device.label,
      })}
      tone={result.ok ? "success" : "error"}
    >
      {result.error ? <p>{result.error}</p> : null}
      {missing.length ? (
        <p>{t("install.stillMissing", { missing: missingText(missing) })}</p>
      ) : result.ok ? (
        <p>{t("install.nothingMissing")}</p>
      ) : null}
    </Alert>
  );
}
