import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { extendResourceLease, releaseResource } from "../../api";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { MutedText } from "../../components/ui/text";
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
  if (!holder && !resetting && !action.running) return null;

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
    <div className="grid min-w-0 gap-1.5" aria-busy={Boolean(action.running)}>
      {holder ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-normal text-ink">
          <span>{leaseWords}</span>
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
            onClick={() => navigateToChat(holder.sessionId, holder.workspaceId)}
          >
            {t("holder.open")}
          </Button>
        </p>
      ) : null}
      {holder && queue > 0 ? (
        <MutedText className="leading-normal" tone="warning">
          {t("holder.queue", { count: queue })}
          {holder.preemptAt
            ? ` · ${t("holder.preempt", { time: clockTime(holder.preemptAt) })}`
            : ""}
        </MutedText>
      ) : holder?.preemptAt ? (
        <MutedText className="leading-normal" tone="warning">
          {t("holder.preempt", { time: clockTime(holder.preemptAt) })}
        </MutedText>
      ) : null}
      {resetting ? (
        <MutedText className="leading-normal" tone="warning">
          {t("holder.resetting")}
        </MutedText>
      ) : null}
      {holder && manageable ? (
        <ButtonRow>
          <Button
            aria-busy={action.running === "release"}
            disabled={Boolean(action.running)}
            size="sm"
            variant="danger"
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
        </ButtonRow>
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
