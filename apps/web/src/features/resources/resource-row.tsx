import { useState } from "react";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { MutedText } from "../../components/ui/text";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { ResourceActivityDialog } from "./resource-activity";
import {
  cuaDriverCheckDetailKeys,
  ResourceBackends,
} from "./resource-backends";
import { ResourceComputeAccess } from "./resource-compute-access";
import {
  computeDetailsText,
  headlineReadiness,
  readinessText,
  stateTone,
} from "./resource-groups";
import { ResourceLease } from "./resource-lease";

/**
 * One instance: what it is, whether a session could use it, who holds it,
 * what it reports. Its device's owner (manageable) can release it, set up
 * its backends and read its activity, and on a compute instance allow or
 * stop remote commands.
 */
export function ResourceRow({
  instance,
  manageable = false,
  remoteCommands = false,
  onChanged = () => {},
}: {
  instance: ResourceInstance;
  manageable?: boolean;
  /** Its device allows remote commands (ResourceSourceStatus). */
  remoteCommands?: boolean;
  /** After an action changed it: read the inventory again. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation("resources");
  const [activityOpen, setActivityOpen] = useState(false);
  const reachable = instance.state !== "offline" && instance.state !== "gone";
  const operated =
    Boolean(instance.holder) ||
    instance.backends.some((backend) => backend.mode === "remote_ops");
  const headline = headlineReadiness(instance);
  const readiness = readinessText(headline);
  const stateReason =
    instance.state !== "available" &&
    instance.state !== "busy" &&
    instance.stateReason &&
    instance.stateReason !== instance.readiness.reason &&
    instance.stateReason !== headline.reason
      ? instance.stateReason
      : "";
  const compute = instance.type === "compute";
  // cua-driver's permission checks are shown with its backend.
  const details = compute
    ? []
    : Object.entries(instance.details ?? {}).filter(
        ([key]) => !cuaDriverCheckDetailKeys.has(key),
      );
  const computeDetails = compute
    ? computeDetailsText(instance.details ?? {})
    : "";
  const seen =
    instance.state === "gone" && instance.goneAt
      ? {
          at: instance.goneAt,
          text: t("goneSince", { when: relativeWhen(instance.goneAt) }),
        }
      : {
          at: instance.lastSeenAt,
          text: t("lastSeen", { when: relativeWhen(instance.lastSeenAt) }),
        };
  return (
    <li
      className="fdy-res-row group/row grid min-w-0 gap-1"
      data-state={instance.state}
      data-stale={instance.stale ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="text-sm font-semibold text-ink wrap-anywhere group-data-[state=gone]/row:text-ink-muted">
            {instance.name}
          </strong>
          <small className="text-xs leading-normal text-ink-muted">
            {t(`platforms.${instance.platform}`, {
              defaultValue: instance.platform,
            })}
          </small>
        </span>
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={stateTone(instance.state)}>
            {t(`states.${instance.state}`)}
          </Badge>
          {instance.stale ? (
            <>
              <Badge dot={false} tone="brass">
                {t("stale")}
              </Badge>
              <HelpHint label={t("staleHelpLabel")}>
                {t("staleNotice")}
              </HelpHint>
            </>
          ) : null}
        </span>
      </div>
      <p
        className="fdy-res-readiness text-xs leading-normal text-ink wrap-anywhere data-[ready=false]:text-warning-text"
        data-ready={headline.ready ? "true" : "false"}
      >
        {readiness}
      </p>
      {stateReason ? (
        <MutedText className="leading-normal" tone="warning">
          {stateReason}
        </MutedText>
      ) : null}
      <ResourceLease
        instance={instance}
        manageable={manageable}
        onChanged={onChanged}
      />
      <ResourceBackends
        instance={instance}
        setup={manageable && reachable}
        onChanged={onChanged}
      />
      {computeDetails ? (
        <MutedText className="fdy-res-meta leading-normal">
          {computeDetails}
        </MutedText>
      ) : null}
      {compute && manageable ? (
        <ResourceComputeAccess
          allowed={remoteCommands}
          instance={instance}
          onChanged={onChanged}
        />
      ) : null}
      {details.length ? (
        <dl className="fdy-res-details m-0 flex flex-wrap gap-x-3.5 gap-y-0.5 text-xs leading-normal text-ink-muted">
          {details.map(([key, value]) => (
            <div className="flex min-w-0 gap-1" key={key}>
              <dt className="after:content-[':']">{key}</dt>
              <dd className="m-0 text-ink wrap-anywhere">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <time
          className="fdy-res-meta text-xs leading-normal text-ink-muted wrap-anywhere"
          dateTime={seen.at}
          title={fullWhen(seen.at)}
        >
          {seen.text}
        </time>
        {manageable && operated ? (
          <Button
            aria-label={t("activity.actionLabel", { name: instance.name })}
            size="sm"
            variant="ghost"
            onClick={() => setActivityOpen(true)}
          >
            <History aria-hidden="true" size={14} />
            {t("activity.action")}
          </Button>
        ) : null}
      </div>
      {activityOpen ? (
        <ResourceActivityDialog
          instance={instance}
          onClose={() => setActivityOpen(false)}
        />
      ) : null}
    </li>
  );
}
