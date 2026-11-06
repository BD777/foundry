import { useToast } from "../../components/ui/toast";
import { Alert } from "../../components/ui/alert";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import { checkExternalConnection, removeExternalConnection } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";
import { i18n } from "../../i18n";
import {
  externalConnectionState,
  quotaResetText,
  type ExternalConnectionState,
} from "../../lib/profile-status";
import { Spinner } from "../../components/ui/loading";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DeviceAccountDefaults } from "./device-account-defaults";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import {
  ManagementList,
  ManagementRow,
  ManagementRowCopy,
} from "../../components/ui/management-row";

const stateTone: Record<
  ExternalConnectionState,
  "online" | "warn" | "error" | "neutral"
> = {
  ready: "online",
  unchecked: "neutral",
  failed: "error",
  quota_exhausted: "warn",
  helper_missing: "warn",
};

function checkedAt(value: string): string {
  return new Date(value).toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The device's external model connections, each a row with its state and
 * explicit actions. A gateway's installer registers them on the device;
 * here its owner checks one (a short conversation that uses quota, never
 * automatic) or removes it.
 */
export function DeviceExternalConnections({
  device,
  rows,
  onRefresh,
}: {
  device: DeviceProjection;
  rows: AgentProfileProjection[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const idPrefix = useId();
  const [busy, setBusy] = useState<{
    id: string;
    action: "check" | "remove";
  }>();
  const [open, setOpen] = useState<string>();
  const notify = useToast();
  /** "Limen's quota is used up · resets 2pm (America/Toronto)". */
  const quotaText = (
    row: AgentProfileProjection,
    message: string | undefined,
  ): string => {
    const name = row.connector?.label ?? row.label;
    const reset = quotaResetText(message);
    return reset
      ? t("providers.externalQuotaResets", { name, reset })
      : t("providers.externalQuota", { name });
  };
  if (!rows.length) return null;
  const online = device.status === "connected";
  const manageable = online && device.owned !== false;

  async function run(
    row: AgentProfileProjection,
    action: "check" | "remove",
  ): Promise<void> {
    if (busy) return;
    setBusy({ id: row.id, action });
    try {
      if (action === "check") {
        const result = await checkExternalConnection(device.id, row.id);
        notify(
          result.status === "passed"
            ? {
                tone: "success",
                title: t("providers.externalChecked", { name: row.label }),
              }
            : result.reason === "quota_exhausted"
              ? {
                  tone: "warning",
                  title: quotaText(row, result.message),
                  description: result.message,
                }
              : {
                  tone: "error",
                  title: t("providers.externalCheckFailed", {
                    name: row.label,
                  }),
                  description: result.message,
                },
        );
      } else {
        await removeExternalConnection(device.id, row.id);
        notify({
          tone: "success",
          title: t("providers.externalRemoved", {
            name: row.label,
            device: device.label,
          }),
        });
      }
      await onRefresh();
    } catch (cause) {
      notify({
        tone: "error",
        title: t("providers.externalActionFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      {device.owned === false ? (
        <Alert
          size="compact"
          title={t("providers.externalOwnerOnly")}
          tone="info"
        />
      ) : !online ? (
        <Alert
          size="compact"
          title={t("providers.externalOffline")}
          tone="info"
        />
      ) : null}
      <ManagementList>
        {rows.map((row, index) => {
          const nameId = `${idPrefix}-${index}`;
          const state = externalConnectionState(row);
          const rowBusy = busy?.id === row.id ? busy.action : undefined;
          const defaultsOpen = open === row.id;
          const detail =
            state === "helper_missing"
              ? t("providers.externalHelperMissing")
              : state === "unchecked"
                ? t("providers.externalUncheckedHint")
                : state === "failed"
                  ? t("providers.externalFailed", {
                      reason: row.check?.message || row.statusDetail || "",
                    })
                  : state === "quota_exhausted"
                    ? quotaText(row, row.check?.message)
                    : undefined;
          return (
            <ManagementRow
              key={row.id}
              className={defaultsOpen ? "flex-wrap" : undefined}
            >
              <RuntimeMark runtime={row.runtime} />
              <ManagementRowCopy>
                <strong id={nameId}>{row.label}</strong>
                <small>
                  {[
                    t("providers.externalMeta", { model: row.model ?? "" }),
                    row.connector
                      ? t("providers.externalViaConnector", {
                          connector: row.connector.label,
                        })
                      : t("providers.externalLegacy"),
                    row.check?.checkedAt
                      ? t("providers.answered", {
                          time: checkedAt(row.check.checkedAt),
                        })
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                {detail ? <small>{detail}</small> : null}
              </ManagementRowCopy>
              <Badge tone={stateTone[state]}>
                {t(`providers.externalStates.${state}`)}
              </Badge>
              <span className="flex flex-wrap gap-2">
                {device.owned === false ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={defaultsOpen}
                    aria-label={t("environments.defaultsLabel", {
                      name: row.label,
                      device: device.label,
                    })}
                    onClick={() => setOpen(defaultsOpen ? undefined : row.id)}
                  >
                    {t("environments.defaults")}
                    {defaultsOpen ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  // The busy button keeps focus; the others wait.
                  disabled={
                    !manageable ||
                    (busy !== undefined && rowBusy !== "check") ||
                    state === "helper_missing"
                  }
                  aria-disabled={rowBusy === "check" || undefined}
                  aria-busy={rowBusy === "check"}
                  aria-describedby={nameId}
                  onClick={() => void run(row, "check")}
                >
                  {rowBusy === "check" ? <Spinner /> : null}
                  {rowBusy === "check"
                    ? t("providers.externalChecking")
                    : row.check?.checkedAt
                      ? t("providers.externalCheckAgain")
                      : t("providers.externalCheck")}
                </Button>
                {row.connector ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-describedby={nameId}
                    onClick={() => navigateToConnectors(row.connector!.kind)}
                  >
                    {t("providers.externalManageConnector", {
                      connector: row.connector.label,
                    })}
                  </Button>
                ) : (
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    disabled={
                      !manageable ||
                      (busy !== undefined && rowBusy !== "remove")
                    }
                    aria-disabled={rowBusy === "remove" || undefined}
                    aria-busy={rowBusy === "remove"}
                    aria-describedby={nameId}
                    confirmLabel={t("providers.externalRemoveConfirm")}
                    onConfirm={() => void run(row, "remove")}
                  >
                    {rowBusy === "remove"
                      ? t("providers.externalRemoving")
                      : t("providers.externalRemove")}
                  </ConfirmButton>
                )}
              </span>
              {defaultsOpen ? (
                <div className="min-w-0 basis-full">
                  <DeviceAccountDefaults
                    key={row.id}
                    device={device}
                    profile={row}
                    placement="below"
                    onRefresh={onRefresh}
                  />
                </div>
              ) : null}
            </ManagementRow>
          );
        })}
      </ManagementList>
    </>
  );
}
