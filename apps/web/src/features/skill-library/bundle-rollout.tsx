import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  SkillBundleCheckStep,
  SkillBundleRollout,
  SkillBundleRolloutDevice,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { setSkillBundleUpdatePolicy, updateSkillBundle } from "../../api";
import { i18n } from "../../i18n";
import {
  bundleUpdatePolicy,
  bundleUpdateTargets,
  checkErrorReason,
  checkStepLine,
  checkSummary,
  checkText,
  failedStepText,
  rolloutProgress,
  rolloutRunning,
  type BundleUpdatePolicy,
  type DeviceNamer,
} from "../../lib/bundle-versions";
import { dateTime } from "../../lib/time-format";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { ProgressMeter } from "../../components/ui/progress-meter";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SkillNote } from "../../components/skills/skill-note";
import {
  BundleStateBadge,
  checkStepLook,
  rolloutDeviceLook,
} from "../../components/skills/bundle-state-badge";

/** A repository with no release is followed by its short commit. */
export const isShortCommit = (version: string) => /^[0-9a-f]{7}$/.test(version);

/** A version as people read it: a release tag, or "commit abc1234". */
export function versionName(tag: string): string {
  return isShortCommit(tag)
    ? i18n.t("skills:library.bundle.commit", { commit: tag })
    : tag;
}

/** Names devices by the page's projection, for entries without a name. */
export const namerFor =
  (devices: DeviceProjection[]): DeviceNamer =>
  (id) =>
    devices.find((device) => device.id === id)?.label;

/**
 * How a bundle updates its devices, as one fact of the card: Automatic or
 * Manual (Admins switch it; members read it), with what that means in a
 * short line under the control.
 */
export function BundlePolicyControl({
  repo,
  canManage,
  busy,
  run,
}: {
  repo: SkillRepository;
  canManage: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation("skills");
  const policy = bundleUpdatePolicy(repo);
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-ink-muted">
        {t("library.versions.policy.label")}
      </span>
      {canManage ? (
        <SegmentedControl<BundleUpdatePolicy>
          aria-label={t("library.versions.policy.labelFor", {
            name: repo.name || repo.label,
          })}
          onValueChange={(next) => {
            if (next !== policy)
              run(() => setSkillBundleUpdatePolicy(repo.id, next));
          }}
          options={[
            {
              value: "auto",
              label: t("library.versions.policy.auto"),
              disabled: busy,
            },
            {
              value: "manual",
              label: t("library.versions.policy.manual"),
              disabled: busy,
            },
          ]}
          size="sm"
          value={policy}
        />
      ) : (
        <span className="text-sm text-ink">
          {t(`library.versions.policy.${policy}`)}
        </span>
      )}
    </div>
  );
}

/** What the update mode means, in a short line under the card's facts. */
export function BundlePolicyHint({ repo }: { repo: SkillRepository }) {
  const { t } = useTranslation("skills");
  return (
    <SkillNote>
      {t(`library.versions.policy.${bundleUpdatePolicy(repo)}Short`)}
    </SkillNote>
  );
}

/** "N devices are not on v1.44.0" with Update, when devices lag and nothing moves them. */
export function BundleUpdateNotice({
  repo,
  canManage,
  busy,
  run,
}: {
  repo: SkillRepository;
  canManage: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation("skills");
  const targets = bundleUpdateTargets(repo);
  if (!targets.length) return null;
  const newest = repo.versions?.[0]?.tag ?? repo.version ?? "";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-sm text-ink">
        {t("library.versions.updateTargets", {
          count: targets.length,
          tag: versionName(newest),
        })}
      </span>
      {canManage ? (
        <Button
          aria-busy={busy}
          disabled={busy}
          onClick={() => run(() => updateSkillBundle(repo.id))}
          size="sm"
          variant="secondary"
        >
          {t("library.versions.update")}
        </Button>
      ) : null}
    </div>
  );
}

/** Device states that move, or moved, it to the rollout's version. */
const moving = new Set<SkillBundleRolloutDevice["state"]>([
  "pending",
  "installing",
  "checking",
  "updated",
]);

/** "v1.41.0" out of "feishu-cli v1.41.0"; several tools stay as they are. */
const fromVersion = (from: string) => from.match(/^\S+ (\S+)$/)?.[1] ?? from;

/** The rollout's line: where it is, or why it stopped. */
function rolloutLine(rollout: SkillBundleRollout, name: DeviceNamer): string {
  const t = i18n.t.bind(i18n);
  const tag = versionName(rollout.tag);
  const { updated, total } = rolloutProgress(rollout);
  const canary = rollout.devices.find(
    (device) => device.deviceId === rollout.canaryDeviceId,
  );
  const canaryName = canary
    ? canary.deviceName || name(canary.deviceId) || canary.deviceId
    : "";
  switch (rollout.state) {
    case "waiting":
      return t("skills:library.versions.rollout.lineWaiting", { tag });
    case "done":
      return t("skills:library.versions.rollout.lineDone", {
        tag,
        updated,
        total,
      });
    case "rolled_back": {
      const step = failedStepText(canary?.check);
      const why =
        canaryName && step
          ? t("skills:library.versions.rollout.rolledBackWhy", {
              device: canaryName,
              step,
            })
          : rollout.error
            ? checkErrorReason(rollout.error)
            : t("skills:library.versions.rollout.rolledBack", { tag });
      return t("skills:library.versions.rollout.lineRolledBack", { tag, why });
    }
    case "failed":
      return t("skills:library.versions.rollout.lineFailed", {
        tag,
        why: checkErrorReason(rollout.error ?? ""),
      });
    default:
      return t("skills:library.versions.rollout.line", {
        tag,
        updated,
        total,
      });
  }
}

/**
 * The latest rollout, while it runs or just after: one line with a slim
 * progress bar and its time, then a compact row per device ("v1.41.0 →
 * v1.44.0"); the canary's checks are one line that opens to a line per
 * check. A rolled-back one says updates are paused (Resume sits in the
 * card's header).
 */
export function BundleRolloutSection({
  rollout,
  paused,
  name,
}: {
  rollout: SkillBundleRollout;
  paused: boolean;
  name: DeviceNamer;
}) {
  const { t } = useTranslation("skills");
  const tag = versionName(rollout.tag);
  const { updated, total } = rolloutProgress(rollout);
  const running = rolloutRunning(rollout);
  const time = running
    ? t("library.versions.rollout.startedAt", {
        time: dateTime(rollout.startedAt),
      })
    : rollout.finishedAt
      ? dateTime(rollout.finishedAt)
      : "";
  const canary = rollout.devices.find(
    (device) => device.deviceId === rollout.canaryDeviceId,
  );
  const devices = canary
    ? [canary, ...rollout.devices.filter((device) => device !== canary)]
    : rollout.devices;
  const stopped = rollout.state === "rolled_back" || rollout.state === "failed";
  return (
    <section
      aria-label={t("library.versions.rollout.target", { tag })}
      className="grid min-w-0 gap-1.5 border-t border-line pt-2"
      data-rollout-state={rollout.state}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={
            stopped
              ? "min-w-0 text-sm text-error-text [overflow-wrap:anywhere]"
              : "min-w-0 text-sm text-ink [overflow-wrap:anywhere]"
          }
        >
          {rolloutLine(rollout, name)}
        </span>
        {time ? <SkillNote>{time}</SkillNote> : null}
      </div>
      {running && total ? (
        <ProgressMeter
          aria-label={t("library.versions.rollout.progressLabel", {
            updated,
            total,
            tag,
          })}
          className="max-w-72"
          max={total}
          value={updated}
        />
      ) : null}
      {devices.length ? (
        <ul className="grid min-w-0 gap-1">
          {devices.map((device) => (
            <RolloutDeviceRow
              canary={device === canary}
              device={device}
              key={device.deviceId}
              name={name}
              tag={tag}
            />
          ))}
        </ul>
      ) : null}
      {rollout.state === "rolled_back" && paused ? (
        <SkillNote data-tone="warning">
          {t("library.versions.rollout.pausedLine")}
        </SkillNote>
      ) : null}
    </section>
  );
}

function RolloutDeviceRow({
  device,
  canary,
  name,
  tag,
}: {
  device: SkillBundleRolloutDevice;
  canary: boolean;
  name: DeviceNamer;
  tag: string;
}) {
  const { t } = useTranslation("skills");
  const label = device.deviceName || name(device.deviceId) || device.deviceId;
  return (
    <li className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="font-medium text-ink">{label}</span>
        {device.owner ? (
          <span className="text-ink-muted">
            {t("library.versions.rollout.ownedBy", { owner: device.owner })}
          </span>
        ) : null}
        {canary ? (
          <Badge dot={false} tone="brass">
            {t("library.versions.rollout.canaryBadge")}
          </Badge>
        ) : null}
        <BundleStateBadge look={rolloutDeviceLook[device.state]}>
          {t(`library.versions.rollout.deviceState.${device.state}`)}
        </BundleStateBadge>
        {device.from ? (
          <span className="text-ink-muted">
            {moving.has(device.state)
              ? t("library.versions.rollout.move", {
                  from: fromVersion(device.from),
                  to: tag,
                })
              : t("library.versions.rollout.stays", {
                  from: fromVersion(device.from),
                })}
          </span>
        ) : null}
      </span>
      {device.error && !device.check ? (
        <SkillNote data-tone="warning">
          {checkErrorReason(device.error)}
        </SkillNote>
      ) : null}
      {device.check?.steps.length ? (
        <Disclosure className="pl-3">
          <DisclosureSummary
            aria-label={t("library.versions.rollout.checkSteps", {
              device: label,
            })}
          >
            {checkSummary(device.check)}
          </DisclosureSummary>
          <ul className="grid min-w-0 gap-1">
            {device.check.steps.map((step, index) => (
              <CheckStepRow key={`${step.name}-${index}`} step={step} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </li>
  );
}

/** One check in one line; a failed one keeps its (redacted) output behind Details. */
function CheckStepRow({ step }: { step: SkillBundleCheckStep }) {
  const { t } = useTranslation("skills");
  return (
    <li className="grid min-w-0 gap-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <BundleStateBadge look={checkStepLook[step.state]}>
          {t(`library.versions.check.step.${step.state}`)}
        </BundleStateBadge>
        <span className="min-w-0 text-ink [overflow-wrap:anywhere]">
          {checkStepLine(step)}
        </span>
        {step.state === "skipped" && step.detail ? (
          <span className="text-ink-muted">· {step.detail}</span>
        ) : null}
      </span>
      {step.state === "failed" && step.detail ? (
        <Disclosure className="pl-3">
          <DisclosureSummary>
            {t("library.versions.check.details")}
          </DisclosureSummary>
          <pre className="m-0 max-h-40 overflow-auto rounded-sm bg-inset p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
            {step.detail}
          </pre>
        </Disclosure>
      ) : null}
    </li>
  );
}

/**
 * Every version the bundle was on, newest first, with its check; the
 * summary line says what the latest one did ("Updated to v1.44.0 · 9
 * changed").
 */
export function VersionHistory({
  repo,
  latest,
  name,
}: {
  repo: SkillRepository;
  latest: string;
  name: DeviceNamer;
}) {
  const { t } = useTranslation("skills");
  const versions = repo.versions ?? [];
  if (!versions.length) return null;
  return (
    <Disclosure>
      <DisclosureSummary>
        {latest
          ? t("library.versions.historyLatest", { latest })
          : t("library.versions.history", { count: versions.length })}
      </DisclosureSummary>
      <ul className="grid min-w-0 gap-1">
        {versions.map((version) => (
          <li
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
            key={version.seq}
          >
            <span className="font-mono text-ink">
              {versionName(version.tag)}
            </span>
            <span>
              {[
                version.appliedAt ? dateTime(version.appliedAt) : "",
                version.rolledBack ? t("library.versions.rolledBackEntry") : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {repo.tools?.length ? (
              <BundleStateBadge
                look={
                  version.check?.state === "passed"
                    ? "ok"
                    : version.check?.state === "failed"
                      ? "failed"
                      : "unchecked"
                }
              >
                {checkText(version.check, name)}
              </BundleStateBadge>
            ) : null}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
