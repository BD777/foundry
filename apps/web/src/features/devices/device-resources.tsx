import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { DeviceProjection, DeviceResource } from "@bd777/foundry-protocol";
import { refreshDeviceResources } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { InfoRow } from "../../components/ui/info-row";
import { i18n } from "../../i18n";
import { navigateToResources } from "../../lib/in-app-navigation";
import { useResourceInventory } from "../../lib/resource-inventory";

function kindLabel(kind: DeviceResource["kind"]): string {
  return kind in kindKeys ? i18n.t(kindKeys[kind]) : kind;
}

const kindKeys = {
  browser: "devices:resources.kinds.browser",
  computer_use: "devices:resources.kinds.computer_use",
} as const;

/**
 * One line on what the resource inventory lists for the device ("5
 * resources · 1 not ready") and the way to the Resources page filtered to it.
 */
function DeviceResourceSummary({ device }: { device: DeviceProjection }) {
  const { t } = useTranslation("devices");
  const { list, error, loading } = useResourceInventory({ device: device.id });
  const instances = (list?.instances ?? []).filter(
    (instance) => instance.source.id === device.id,
  );
  const unready = instances.filter(
    (instance) => instance.state === "unready",
  ).length;
  const stale = instances.filter((instance) => instance.stale).length;
  const source = list?.sources.find((item) => item.id === device.id);
  const summary = list
    ? [
        t("resources.summary.count", { count: instances.length }),
        unready ? t("resources.summary.unready", { count: unready }) : "",
        stale ? t("resources.summary.stale", { count: stale }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : t(
        error && !loading
          ? "resources.summary.failed"
          : "resources.summary.loading",
      );
  return (
    <div
      aria-label={t("resources.summary.label", { device: device.label })}
      className="fdy-device-resource-summary"
      role="group"
    >
      <span role="status">{summary}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => navigateToResources(device.id)}
      >
        {t("resources.summary.open")}
        <ArrowRight aria-hidden="true" size={14} />
      </Button>
      {source ? (
        <span className="fdy-device-resource-remote">
          <span>
            {t(
              source.allowRemoteCommands
                ? "resources.summary.remoteOn"
                : "resources.summary.remoteOff",
            )}
          </span>
          {device.owned ? <span aria-hidden="true">·</span> : null}
          {device.owned ? (
            <Button
              aria-label={t("resources.summary.manageRemoteLabel", {
                device: device.label,
              })}
              size="sm"
              variant="ghost"
              onClick={() => navigateToResources(device.id, "compute")}
            >
              {t("resources.summary.manageRemote")}
              <ArrowRight aria-hidden="true" size={14} />
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Resource Pool directory for one device: what its worker found that
 * sessions may use. Foundry lists the device's own software and installs
 * nothing. The device's owner can have it detect again, and for a resource
 * that needs the person's permission (macOS screen control) have the device
 * show its permission prompts and open the right System Settings pane.
 */
export function DeviceResources({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const resources = device.resources ?? [];
  const manageable = Boolean(device.owned) && device.status === "connected";
  const { t } = useTranslation("devices");
  const [busy, setBusy] = useState<"detect" | "access" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async (requestAccess?: string) => {
    setBusy(requestAccess ? "access" : "detect");
    setMessage("");
    setError("");
    try {
      const result = await refreshDeviceResources(device.id, requestAccess);
      await onRefresh();
      const pending = result.resources.find(
        (resource) => resource.id === requestAccess && !resource.available,
      );
      setMessage(
        !requestAccess
          ? t("resources.detected")
          : result.opened.length && pending
            ? t("resources.settingsOpen", {
                device: device.label,
                panes: result.opened.join(", "),
              })
            : pending
              ? t("resources.promptsShown", { device: device.label })
              : t("resources.granted"),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("resources.unreachable"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="fdy-device-section"
      aria-labelledby="fdy-device-resources-heading"
    >
      <header className="fdy-management-heading">
        <div>
          <h2 id="fdy-device-resources-heading">{t("resources.title")}</h2>
          <p>{t("resources.intro", { device: device.label })}</p>
        </div>
        {manageable ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={busy === "detect" ? "fdy-spin" : undefined}
              size={14}
            />
            {busy === "detect"
              ? t("resources.detecting")
              : t("resources.detectAgain")}
          </Button>
        ) : null}
      </header>
      <DeviceResourceSummary device={device} />
      {resources.length === 0 ? (
        <EmptyState
          title={t("resources.emptyTitle")}
          body={t(
            device.status === "connected"
              ? "resources.emptyOnline"
              : "resources.emptyOffline",
          )}
        />
      ) : (
        <ul
          className="fdy-device-resources"
          aria-label={t("resources.listLabel")}
        >
          {resources.map((resource) => (
            <li key={resource.id}>
              <InfoRow
                label={`${resource.name} · ${kindLabel(resource.kind)}`}
                meta={resource.attributes?.path}
              >
                <Badge tone={resource.available ? "online" : "warn"}>
                  {t(
                    resource.available
                      ? "resources.available"
                      : "resources.unavailable",
                  )}
                </Badge>
              </InfoRow>
              {resource.detail ? (
                <p className="fdy-device-resource-detail">{resource.detail}</p>
              ) : null}
              {resource.kind === "computer_use" &&
              !resource.available &&
              manageable ? (
                <div className="fdy-device-resource-access">
                  <p>
                    <Trans
                      ns="devices"
                      i18nKey={
                        resource.attributes?.grantTo
                          ? "resources.screenAccessGrantTo"
                          : "resources.screenAccess"
                      }
                      values={{
                        device: device.label,
                        grantTo: resource.attributes?.grantTo,
                      }}
                      components={{ code: <code /> }}
                    />
                  </p>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void refresh(resource.id)}
                  >
                    {busy === "access"
                      ? t("resources.asking")
                      : t("resources.openSettings")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p className="fdy-device-resource-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
