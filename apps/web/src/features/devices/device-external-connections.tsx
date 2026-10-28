import { useToast } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
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
import { RuntimeMark } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import {
  externalConnectionManageCapability,
  externalConnectionState,
  type ExternalConnectionState,
} from "../../lib/profile-status";
import { Spinner } from "../../components/ui/loading";

const stateTone: Record<
  ExternalConnectionState,
  "online" | "warn" | "error" | "neutral"
> = {
  ready: "online",
  unchecked: "neutral",
  failed: "error",
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
  const notify = useToast();
  if (!rows.length) return null;
  const online = device.status === "connected";
  const capable = Boolean(
    device.capabilities?.includes(externalConnectionManageCapability),
  );
  const manageable = online && capable && device.owned !== false;

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
            : {
                tone: "error",
                title: t("providers.externalCheckFailed", { name: row.label }),
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
      <div className="fdy-management-list">
        {rows.map((row, index) => {
          const nameId = `${idPrefix}-${index}`;
          const state = externalConnectionState(row);
          const rowBusy = busy?.id === row.id ? busy.action : undefined;
          const detail =
            state === "helper_missing"
              ? t("providers.externalHelperMissing")
              : state === "unchecked"
                ? t("providers.externalUncheckedHint")
                : state === "failed"
                  ? t("providers.externalFailed", {
                      reason: row.check?.message || row.statusDetail || "",
                    })
                  : undefined;
          return (
            <div className="fdy-management-row" key={row.id}>
              <RuntimeMark runtime={row.runtime} />
              <span>
                <strong id={nameId}>{row.label}</strong>
                <small>
                  {[
                    t("providers.externalMeta", { model: row.model ?? "" }),
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
              </span>
              <Badge tone={stateTone[state]}>
                {t(`providers.externalStates.${state}`)}
              </Badge>
              <span className="fdy-external-connection-actions">
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
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  disabled={
                    !manageable || (busy !== undefined && rowBusy !== "remove")
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
              </span>
            </div>
          );
        })}
      </div>
      {device.owned === false ? (
        <p>{t("providers.externalOwnerOnly")}</p>
      ) : !online ? (
        <p>{t("providers.externalOffline")}</p>
      ) : !capable ? (
        <p>{t("providers.externalUpdateWorker")}</p>
      ) : null}
      <p>{t("providers.externalActionsNote")}</p>
      <FieldHint>
        {t("providers.externalRegisterHint", {
          command: "foundry-worker connection add",
        })}
      </FieldHint>
    </>
  );
}
