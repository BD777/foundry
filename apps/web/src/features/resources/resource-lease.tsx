import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { extendResourceLease, releaseResource } from "../../api";
import { Button } from "../../components/ui/button";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";
import { clockTime } from "./resource-groups";

/**
 * Who holds an instance and for how long, who waits for it and, for the
 * device's owner, Release and (when a waiting session will take it) "Let it
 * finish".
 */
export function ResourceLease({
  instance,
  manageable,
  onChanged,
}: {
  instance: ResourceInstance;
  manageable: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const action = useResourceAction<"release" | "extend">();
  const [confirming, setConfirming] = useState(false);
  const { holder, queue = 0, resetting } = instance;
  if (!holder && !resetting && !action.notice && !action.error) return null;

  const leaseWords = !holder
    ? ""
    : holder.state === "active"
      ? t("holder.active")
      : holder.state === "parked"
        ? holder.parkUntil
          ? t("holder.parked", { time: clockTime(holder.parkUntil) })
          : t("holder.parkedOpen")
        : t("holder.ending");

  const release = () =>
    void action.run("release", async () => {
      await releaseResource(instance.id);
      onChanged();
      return t("lease.released");
    });
  const extend = () =>
    void action.run("extend", async () => {
      const { lease } = await extendResourceLease(instance.id);
      onChanged();
      return t("lease.extended", { time: clockTime(lease.preemptAt) });
    });

  return (
    <div className="fdy-res-lease" aria-busy={Boolean(action.running)}>
      {holder ? (
        <p className="fdy-res-holder">
          <span>{leaseWords}</span>
          <time dateTime={holder.since} title={fullWhen(holder.since)}>
            {t("holder.since", { when: relativeWhen(holder.since) })}
          </time>
          <Button
            aria-label={t("holder.openLabel", { name: instance.name })}
            size="inline"
            variant="link"
            onClick={() => navigateToChat(holder.sessionId, holder.workspaceId)}
          >
            {t("holder.open")}
          </Button>
        </p>
      ) : null}
      {holder && queue > 0 ? (
        <p className="fdy-res-note">
          {t("holder.queue", { count: queue })}
          {holder.preemptAt
            ? ` · ${t("holder.preempt", { time: clockTime(holder.preemptAt) })}`
            : ""}
        </p>
      ) : holder?.preemptAt ? (
        <p className="fdy-res-note">
          {t("holder.preempt", { time: clockTime(holder.preemptAt) })}
        </p>
      ) : null}
      {resetting ? (
        <p className="fdy-res-note">{t("holder.resetting")}</p>
      ) : null}
      {holder && manageable ? (
        <div className="fdy-res-actions">
          <Button
            aria-busy={action.running === "release"}
            className="fdy-res-danger"
            disabled={Boolean(action.running)}
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(true)}
          >
            {action.running === "release"
              ? t("lease.releasing")
              : t("lease.release")}
          </Button>
          {holder.preemptAt ? (
            <Button
              aria-busy={action.running === "extend"}
              disabled={Boolean(action.running)}
              size="sm"
              variant="secondary"
              onClick={extend}
            >
              {action.running === "extend"
                ? t("lease.extending")
                : t("lease.extend")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {action.notice ? (
        <p className="fdy-res-status" role="status">
          {action.notice}
        </p>
      ) : null}
      {action.error ? (
        <p className="fdy-res-error" role="alert">
          {action.error}
        </p>
      ) : null}
      {confirming ? (
        <ResourceConfirmDialog
          confirmLabel={t("lease.releaseConfirm")}
          description={t("lease.releaseDescription")}
          destructive
          items={[
            t("lease.releaseItems.fails"),
            t("lease.releaseItems.reset"),
            t("lease.releaseItems.next"),
          ]}
          title={t("lease.releaseTitle", { name: instance.name })}
          onClose={() => setConfirming(false)}
          onConfirm={release}
        />
      ) : null}
    </div>
  );
}
