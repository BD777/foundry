import type {
  ConnectorPackageView,
  ConnectorServerHeldInstance,
  ConnectorServerHeldSpec,
  ExternalAccountStatus,
} from "@bd777/foundry-protocol";
import { Pencil, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { DividedList } from "../../components/ui/divided-list";
import type { ToastTone } from "../../components/ui/toast";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { statusLabel, statusTone } from "./account-format";
import {
  DeviceAvailability,
  InstancePackageState,
} from "./server-held-device-state";

function instanceStatus(status: string): ExternalAccountStatus {
  return status === "expiring" || status === "revoked" || status === "ready"
    ? status
    : "needs_reauth";
}

export interface ServerHeldInstanceListProps {
  instances: ConnectorServerHeldInstance[];
  serverHeld: ConnectorServerHeldSpec;
  checking?: string;
  packageView?: ConnectorPackageView;
  onCheck: (instance: ConnectorServerHeldInstance) => void;
  onEdit: (instance: ConnectorServerHeldInstance) => void;
  onRevoke: (instance: ConnectorServerHeldInstance) => void;
  onDelete: (instance: ConnectorServerHeldInstance) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
  onPackageChanged?: (view: ConnectorPackageView) => void;
}

/** Active instances stay in place; revoked ones open from a quiet count. */
export function ServerHeldInstanceList({
  instances,
  serverHeld,
  checking,
  packageView,
  onCheck,
  onEdit,
  onRevoke,
  onDelete,
  onNotice,
  onPackageChanged,
}: ServerHeldInstanceListProps) {
  const { t } = useTranslation("externalAccounts");
  const active = instances.filter((instance) => instance.status !== "revoked");
  const revoked = instances.filter((instance) => instance.status === "revoked");
  const row = (instance: ConnectorServerHeldInstance) => {
    const baseURL = instance.values[serverHeld.upstream.baseField];
    return (
      <li
        className="fdy-xacc-row grid gap-2.5 py-3"
        data-instance-id={instance.id}
        key={instance.id}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <strong className="min-w-0 wrap-anywhere">{instance.label}</strong>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">
              {t(
                instance.network === "device"
                  ? "serverHeld.networkDevice"
                  : "serverHeld.networkServer",
              )}
            </Badge>
            <Badge tone={statusTone(instanceStatus(instance.status))}>
              {statusLabel(instanceStatus(instance.status))}
            </Badge>
          </div>
        </div>
        <div className="grid min-w-0 gap-1 text-xs text-ink-muted">
          {baseURL ? <span className="wrap-anywhere">{baseURL}</span> : null}
          <span>
            {[
              instance.access === "write"
                ? t("serverHeld.accessWrite")
                : instance.access === "read"
                  ? t("serverHeld.accessRead")
                  : null,
              instance.version
                ? t("serverHeld.version", { version: instance.version })
                : null,
              typeof instance.routeCount === "number" &&
              instance.routeCount >= 0
                ? t("serverHeld.routeCount", { count: instance.routeCount })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {instance.updatedAt ? (
            <time
              dateTime={instance.updatedAt}
              title={fullWhen(instance.updatedAt)}
            >
              {t("serverHeld.checkedAt", {
                when: relativeWhen(instance.updatedAt),
              })}
            </time>
          ) : null}
          {instance.network === "device" ? (
            <DeviceAvailability
              devices={instance.availableDevices}
              probeDeviceId={instance.probeDeviceId}
            />
          ) : null}
          {packageView ? (
            <InstancePackageState
              instance={instance}
              onChanged={onPackageChanged}
              onNotice={onNotice}
              view={packageView}
            />
          ) : null}
          {instance.statusDetail && instance.statusDetail !== "ok" ? (
            <span className="wrap-anywhere">
              {t("serverHeld.resultDetail", {
                detail: instance.statusDetail,
              })}
            </span>
          ) : null}
        </div>
        <ButtonRow align="end">
          <Button
            disabled={checking === instance.id || instance.status === "revoked"}
            onClick={() => onCheck(instance)}
            size="sm"
            variant="ghost"
          >
            <RefreshCw
              aria-hidden="true"
              className={checking === instance.id ? "animate-spin" : ""}
              size={14}
            />
            {checking === instance.id
              ? t("serverHeld.checking")
              : t("serverHeld.check")}
          </Button>
          <Button
            disabled={instance.status === "revoked"}
            onClick={() => onEdit(instance)}
            size="sm"
            variant="ghost"
          >
            <Pencil aria-hidden="true" size={14} />
            {t("serverHeld.replaceToken")}
          </Button>
          {instance.status === "revoked" ? (
            <Button
              onClick={() => onDelete(instance)}
              size="sm"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" size={14} />
              {t("serverHeld.delete")}
            </Button>
          ) : (
            <Button
              onClick={() => onRevoke(instance)}
              size="sm"
              variant="ghost"
            >
              <ShieldOff aria-hidden="true" size={14} />
              {t("serverHeld.revoke")}
            </Button>
          )}
        </ButtonRow>
      </li>
    );
  };

  return (
    <div className="grid min-w-0 gap-3">
      {active.length ? <DividedList>{active.map(row)}</DividedList> : null}
      {revoked.length ? (
        <Disclosure className="border-t border-line-soft pt-3">
          <DisclosureSummary>
            {t("serverHeld.revokedInstances", { count: revoked.length })}
          </DisclosureSummary>
          <DividedList density="compact">{revoked.map(row)}</DividedList>
        </Disclosure>
      ) : null}
    </div>
  );
}
