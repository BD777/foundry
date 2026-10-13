import { useState } from "react";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { fullWhen, relativeWhen } from "../../lib/relative-time";
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
      className="fdy-res-row"
      data-state={instance.state}
      data-stale={instance.stale ? "true" : undefined}
    >
      <div className="fdy-res-row-main">
        <span className="fdy-res-identity">
          <strong>{instance.name}</strong>
          <small>
            {t(`platforms.${instance.platform}`, {
              defaultValue: instance.platform,
            })}
          </small>
        </span>
        <span className="fdy-res-badges">
          <Badge tone={stateTone(instance.state)}>
            {t(`states.${instance.state}`)}
          </Badge>
          {instance.stale ? (
            <Badge dot={false} tone="brass">
              {t("stale")}
            </Badge>
          ) : null}
        </span>
      </div>
      <p
        className="fdy-res-readiness"
        data-ready={headline.ready ? "true" : "false"}
      >
        {readiness}
      </p>
      {stateReason ? <p className="fdy-res-note">{stateReason}</p> : null}
      {instance.stale ? <p className="fdy-res-note">{t("staleNote")}</p> : null}
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
      {computeDetails ? <p className="fdy-res-meta">{computeDetails}</p> : null}
      {compute && manageable ? (
        <ResourceComputeAccess
          allowed={remoteCommands}
          instance={instance}
          onChanged={onChanged}
        />
      ) : null}
      {details.length ? (
        <dl className="fdy-res-details">
          {details.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="fdy-res-row-foot">
        <time
          className="fdy-res-meta"
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
