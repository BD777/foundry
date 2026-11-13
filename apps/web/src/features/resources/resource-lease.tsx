import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceHolder, ResourceInstance } from "@bd777/foundry-protocol";
import { extendResourceLease, releaseResource } from "../../api";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { MutedText } from "../../components/ui/text";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";
import { clockTime } from "./resource-groups";

/** Every live lease on an instance (servers before holders only sent holder). */
export function instanceHolders(instance: ResourceInstance): ResourceHolder[] {
  if (instance.holders?.length) return instance.holders;
  return instance.holder ? [instance.holder] : [];
}

/**
 * Who holds an instance (each lease, shared or exclusive) and for how long,
 * its slots, who waits for it and, for the device's owner, Release and
 * (when a waiting session will take it) "Let it finish" on each lease.
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
  const action = useResourceAction<`${"release" | "extend"}:${string}`>();
  const [confirming, setConfirming] = useState<ResourceHolder>();
  const { queue = 0, resetting, slots } = instance;
  const holders = instanceHolders(instance);
  if (!holders.length && !slots && !resetting && !action.running) return null;

  const leaseWords = (holder: ResourceHolder) =>
    holder.state === "active"
      ? t("holder.active")
      : holder.state === "parked"
        ? holder.parkUntil
          ? t("holder.parked", { time: clockTime(holder.parkUntil) })
          : t("holder.parkedOpen")
        : t("holder.ending");

  const release = (holder: ResourceHolder) =>
    void action.run(`release:${holder.leaseId}`, async () => {
      await releaseResource(instance.id, holder.leaseId);
      onChanged();
      return t("lease.released");
    });
  const extend = (holder: ResourceHolder) =>
    void action.run(`extend:${holder.leaseId}`, async () => {
      const { lease } = await extendResourceLease(instance.id, holder.leaseId);
      onChanged();
      return t("lease.extended", { time: clockTime(lease.preemptAt) });
    });

  return (
    <div className="grid min-w-0 gap-1.5" aria-busy={Boolean(action.running)}>
      {holders.map((holder) => (
        <div
          className="fdy-res-holder grid min-w-0 gap-1"
          data-lease={holder.leaseId}
          key={holder.leaseId}
        >
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-normal text-ink">
            {holder.mode ? (
              <span className="text-ink-muted">
                {t(`holder.modes.${holder.mode}`)}
              </span>
            ) : null}
            <span>{leaseWords(holder)}</span>
            <time
              className="text-ink-muted"
              dateTime={holder.since}
              title={fullWhen(holder.since)}
            >
              {t("holder.since", { when: relativeWhen(holder.since) })}
            </time>
            <Button
              aria-label={t("holder.openLabel", { name: instance.name })}
              size="inline"
              variant="link"
              onClick={() =>
                navigateToChat(holder.sessionId, holder.workspaceId)
              }
            >
              {t("holder.open")}
            </Button>
          </p>
          {holder.preemptAt ? (
            <MutedText className="leading-normal" tone="warning">
              {t("holder.preempt", { time: clockTime(holder.preemptAt) })}
            </MutedText>
          ) : null}
          {manageable ? (
            <ButtonRow>
              <Button
                aria-busy={action.running === `release:${holder.leaseId}`}
                disabled={Boolean(action.running)}
                size="sm"
                variant="danger"
                onClick={() => setConfirming(holder)}
              >
                {action.running === `release:${holder.leaseId}`
                  ? t("lease.releasing")
                  : t("lease.release")}
              </Button>
              {holder.preemptAt ? (
                <Button
                  aria-busy={action.running === `extend:${holder.leaseId}`}
                  disabled={Boolean(action.running)}
                  size="sm"
                  variant="secondary"
                  onClick={() => extend(holder)}
                >
                  {action.running === `extend:${holder.leaseId}`
                    ? t("lease.extending")
                    : t("lease.extend")}
                </Button>
              ) : null}
            </ButtonRow>
          ) : null}
        </div>
      ))}
      {slots ? (
        <MutedText className="fdy-res-slots leading-normal">
          {t("holder.slots", { inUse: slots.inUse, count: slots.capacity })}
          {slots.auto ? ` · ${t("holder.slotsAuto")}` : ""}
        </MutedText>
      ) : null}
      {queue > 0 && (holders.length || slots) ? (
        <MutedText className="leading-normal" tone="warning">
          {t("holder.queue", { count: queue })}
        </MutedText>
      ) : null}
      {resetting ? (
        <MutedText className="leading-normal" tone="warning">
          {t("holder.resetting")}
        </MutedText>
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
          onClose={() => setConfirming(undefined)}
          onConfirm={() => release(confirming)}
        />
      ) : null}
    </div>
  );
}
