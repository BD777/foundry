import type {
  BundleDeviceVersion,
  SkillBundleCheck,
  SkillBundleCheckStep,
  SkillBundleRollout,
  SkillBundleRolloutDevice,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";
import { dateTime } from "./time-format";

/*
 * Where a bundle's devices stand with its versions (docs/skills.md, Bundle
 * 版本): the words the Skill Library and the Connectors page show for a
 * device's CLI against its skills, and for a rollout. Pure: the server's
 * projection in, text out.
 */

export type BundleUpdatePolicy = "auto" | "manual";

export const bundleUpdatePolicy = (
  repo: Pick<SkillRepository, "updatePolicy">,
): BundleUpdatePolicy => repo.updatePolicy ?? "auto";

const runningStates = new Set<SkillBundleRollout["state"]>([
  "waiting",
  "canary",
  "rolling",
]);

/** A rollout that has not finished moves devices still. */
export const rolloutRunning = (rollout?: SkillBundleRollout): boolean =>
  Boolean(rollout && runningStates.has(rollout.state));

const activeDeviceStates = new Set<SkillBundleRolloutDevice["state"]>([
  "pending",
  "installing",
  "checking",
]);

/**
 * A rollout at work now: on its canary, or with a device still to install
 * or check. One that only waits for offline devices (or for a device to
 * start on) is idle: those devices continue when they reconnect, and an
 * Update or the next version takes it over.
 */
export const rolloutMoving = (rollout?: SkillBundleRollout): boolean =>
  Boolean(
    rollout &&
    (rollout.state === "canary" ||
      (rollout.state === "rolling" &&
        rollout.devices.some((device) =>
          activeDeviceStates.has(device.state),
        ))),
  );

const waitingDeviceStates = new Set<SkillBundleRolloutDevice["state"]>([
  "pending",
  "installing",
  "checking",
  "offline",
]);

/**
 * consistent: on the newest version, checked. unchecked: on the newest
 * version, never checked. update-available: on an older recorded version
 * with nothing moving it. waiting: a rollout is moving it. mismatch: its CLI
 * is in no recorded version, so its sessions get the newest skills, which
 * may not match.
 */
export type BundleDeviceStatus =
  "consistent" | "unchecked" | "update-available" | "waiting" | "mismatch";

export function bundleDeviceStatus(
  version: BundleDeviceVersion,
  repo: Pick<SkillRepository, "rollout">,
): BundleDeviceStatus {
  if (version.state === "current")
    return version.verified ? "consistent" : "unchecked";
  const step = repo.rollout?.devices.find(
    (device) => device.deviceId === version.deviceId,
  );
  if (
    rolloutRunning(repo.rollout) &&
    step &&
    waitingDeviceStates.has(step.state)
  )
    return "waiting";
  if (version.state === "unknown") return "mismatch";
  return "update-available";
}

/**
 * The devices an Update would move: behind or mismatched, while no rollout
 * is at work and following is not paused (Resume does that). A device an
 * idle rollout waits for (offline, or every device of one that waits for
 * a device to start on) is not one: it continues when it reconnects.
 */
export function bundleUpdateTargets(
  repo: Pick<SkillRepository, "rollout" | "paused" | "deviceVersions">,
): BundleDeviceVersion[] {
  if (repo.paused || rolloutMoving(repo.rollout)) return [];
  const waitingOffline = new Set(
    rolloutRunning(repo.rollout)
      ? (repo.rollout?.devices ?? [])
          .filter(
            (device) =>
              device.state === "offline" || repo.rollout?.state === "waiting",
          )
          .map((device) => device.deviceId)
      : [],
  );
  return (repo.deviceVersions ?? []).filter(
    (version) =>
      version.state !== "current" && !waitingOffline.has(version.deviceId),
  );
}

export const bundleDeviceStatusLabel = (status: BundleDeviceStatus): string =>
  i18n.t(`skills:library.versions.status.${status}`);

/** "feishu-cli v1.44.0" for each tool Foundry installed there. */
export function deviceToolsText(tools: Record<string, string>): string {
  return Object.entries(tools)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
}

/** "skills v1.44.0", or the newest skills when no version matches. */
export function deviceSkillsText(version: BundleDeviceVersion): string {
  return version.tag
    ? i18n.t("skills:library.versions.skillsAt", { tag: version.tag })
    : i18n.t("skills:library.versions.skillsLatest");
}

/** Names a device: the projection's own name, then the caller's, then its id. */
export type DeviceNamer = (deviceId: string) => string | undefined;

const nameOf = (
  deviceId: string | undefined,
  own: string | undefined,
  name: DeviceNamer,
) => own || (deviceId ? (name(deviceId) ?? deviceId) : "");

/** "passed on sg-chaos", "failed on sg-chaos", or "not checked". */
export function checkText(
  check: SkillBundleCheck | undefined,
  name: DeviceNamer = () => undefined,
): string {
  if (!check) return i18n.t("skills:library.versions.check.none");
  return i18n.t(`skills:library.versions.check.${check.state}`, {
    device: nameOf(check.deviceId, check.deviceName, name),
  });
}

/**
 * A check step in one line, never its output: "Version v1.44.0", "Signed
 * in · token valid", "Token refreshed", "Reached Feishu as Ada"; a failed
 * or skipped step says which check it was.
 */
export function checkStepLine(step: SkillBundleCheckStep): string {
  const t = i18n.t.bind(i18n);
  const service = step.service || t("skills:library.versions.check.service");
  if (step.name === "drill")
    return t("skills:library.versions.check.line.drill");
  const what = step.kind
    ? t(`skills:library.versions.check.kind.${step.kind}`, { service })
    : step.name;
  if (step.state === "skipped")
    return t("skills:library.versions.check.line.skipped", { what });
  if (step.state === "failed")
    return t("skills:library.versions.check.line.failed", { what });
  switch (step.kind) {
    case "version":
      return step.value
        ? t("skills:library.versions.check.line.version", {
            value: step.value,
          })
        : t("skills:library.versions.check.line.passed", { what });
    case "status":
    case "refresh":
      return t(`skills:library.versions.check.line.${step.kind}`);
    case "read":
      return step.value
        ? t("skills:library.versions.check.line.readAs", {
            service,
            value: step.value,
          })
        : t("skills:library.versions.check.line.read", { service });
    default:
      return t("skills:library.versions.check.line.passed", { what });
  }
}

/** A check in one line: "4 checks passed", or the step that broke it. */
export function checkSummary(check: SkillBundleCheck): string {
  const failed = check.steps.find((step) => step.state === "failed");
  if (failed) return checkStepLine(failed);
  const passed = check.steps.filter((step) => step.state === "passed").length;
  return i18n.t("skills:library.versions.check.passedCount", {
    count: passed,
  });
}

/** The step that broke a failed check, in one line. */
export function failedStepText(check?: SkillBundleCheck): string {
  const step = check?.steps.find((entry) => entry.state === "failed");
  return step ? checkStepLine(step) : "";
}

/** How many of a rollout's devices are on its version, of how many. */
export function rolloutProgress(rollout: SkillBundleRollout): {
  updated: number;
  total: number;
} {
  return {
    updated: rollout.devices.filter((device) => device.state === "updated")
      .length,
    total: rollout.devices.length,
  };
}

const recentMs = 24 * 60 * 60 * 1000;

/**
 * Whether the card shows a rollout: while it runs, when it stopped (failed
 * or rolled back, until the next one), or when it finished in the last day.
 */
export function rolloutShown(
  rollout: SkillBundleRollout | undefined,
  now = Date.now(),
): rollout is SkillBundleRollout {
  if (!rollout) return false;
  if (rolloutRunning(rollout)) return true;
  if (rollout.state === "failed" || rollout.state === "rolled_back")
    return true;
  const finished = Date.parse(rollout.finishedAt ?? "");
  return Number.isFinite(finished) && now - finished < recentMs;
}

/** The bundle's one status chip. */
export type BundleStatus =
  | { kind: "paused" }
  | { kind: "updating"; updated: number; total: number; moving: boolean }
  | { kind: "updateFailed" }
  | { kind: "checkFailed" }
  | { kind: "updateAvailable"; count: number }
  | { kind: "upToDate" };

export function bundleStatus(
  repo: Pick<SkillRepository, "paused" | "rollout" | "deviceVersions">,
  checkError?: string,
): BundleStatus {
  if (repo.paused) return { kind: "paused" };
  if (repo.rollout && rolloutRunning(repo.rollout))
    return {
      kind: "updating",
      ...rolloutProgress(repo.rollout),
      moving: rolloutMoving(repo.rollout),
    };
  if (repo.rollout?.state === "failed") return { kind: "updateFailed" };
  if (checkError) return { kind: "checkFailed" };
  const targets = bundleUpdateTargets(repo);
  if (targets.length) return { kind: "updateAvailable", count: targets.length };
  return { kind: "upToDate" };
}

/**
 * Why checking a repository failed, in a few words instead of the tool's
 * output: "CanWendeMac-mini can't resolve bnpm.byted.org". The full text
 * stays in the details.
 */
export function checkErrorReason(error: string): string {
  const t = i18n.t.bind(i18n);
  const first = error.split("\n")[0]?.trim() ?? "";
  const device =
    first.match(/^(.+?) could not reach /)?.[1] ??
    t("skills:library.repo.reason.server");
  const host =
    error.match(/ENOTFOUND[ \t]+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/)?.[1] ??
    error.match(/https?:\/\/([^/\s'"]+)/)?.[1] ??
    first.match(/could not reach ([^\s:]+)/)?.[1] ??
    "";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host/i.test(error))
    return t("skills:library.repo.reason.dns", { device, host });
  if (/ECONNREFUSED|Connection refused/i.test(error))
    return t("skills:library.repo.reason.refused", { device, host });
  if (/ETIMEDOUT|timed out|timeout/i.test(error))
    return t("skills:library.repo.reason.timeout", { device, host });
  if (
    /\b(?:E?401|E?403)\b|unauthori[sz]ed|forbidden|Authentication failed/i.test(
      error,
    )
  )
    return t("skills:library.repo.reason.auth", { device, host });
  const status = error.match(/\b(5\d\d)\b/)?.[1];
  if (status)
    return host
      ? t("skills:library.repo.reason.server5xx", { host, status })
      : t("skills:library.repo.reason.download5xx", { status });
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

const canaryOf = (rollout: SkillBundleRollout) =>
  rollout.devices.find((device) => device.deviceId === rollout.canaryDeviceId);

/**
 * A rollout in one line. Finished: "v1.44.0 rolled out to 3 devices ·
 * canary sg-chaos passed · Nov 9, 2026, 14:02"; rolled back, with the step
 * that failed; running, with where it is.
 */
export function rolloutSummary(
  rollout: SkillBundleRollout,
  name: DeviceNamer = () => undefined,
): string {
  const t = i18n.t.bind(i18n);
  const tag = rollout.tag;
  const total = rollout.devices.length;
  const updated = rollout.devices.filter(
    (device) => device.state === "updated",
  ).length;
  const failed = rollout.devices.filter(
    (device) => device.state === "failed",
  ).length;
  const canary = canaryOf(rollout);
  const canaryName = canary
    ? nameOf(canary.deviceId, canary.deviceName, name)
    : "";
  const canaryPart = (state: "passed" | "failed" | "checking") =>
    canaryName
      ? t(`skills:library.versions.rollout.canary.${state}`, {
          device: canaryName,
        })
      : "";
  const when = rollout.finishedAt ?? rollout.startedAt;
  const at = when ? dateTime(when) : "";
  const parts: string[] = [];
  switch (rollout.state) {
    case "done":
      parts.push(
        updated === total
          ? t("skills:library.versions.rollout.done", { tag, count: total })
          : t("skills:library.versions.rollout.donePartly", {
              tag,
              updated,
              count: total,
            }),
      );
      if (failed)
        parts.push(
          t("skills:library.versions.rollout.failedCount", { count: failed }),
        );
      if (canary?.check) parts.push(canaryPart(canary.check.state));
      parts.push(at);
      break;
    case "rolled_back": {
      const step = failedStepText(canary?.check);
      parts.push(t("skills:library.versions.rollout.rolledBack", { tag }));
      if (canaryName)
        parts.push(
          step
            ? t("skills:library.versions.rollout.canary.failedAt", {
                device: canaryName,
                step,
              })
            : canaryPart("failed"),
        );
      else if (rollout.error) parts.push(rollout.error);
      parts.push(at);
      break;
    }
    case "failed":
      parts.push(
        rollout.error
          ? t("skills:library.versions.rollout.failedWith", {
              tag,
              error: checkErrorReason(rollout.error),
            })
          : t("skills:library.versions.rollout.failed", { tag }),
      );
      parts.push(at);
      break;
    case "waiting":
      parts.push(t("skills:library.versions.rollout.running", { tag }));
      parts.push(t("skills:library.versions.rollout.waitingOnline"));
      break;
    case "canary":
      parts.push(t("skills:library.versions.rollout.running", { tag }));
      parts.push(canaryPart("checking"));
      break;
    case "rolling":
      parts.push(t("skills:library.versions.rollout.running", { tag }));
      parts.push(
        t("skills:library.versions.rollout.progress", {
          updated,
          count: total,
        }),
      );
      break;
  }
  return parts.filter(Boolean).join(" · ");
}

/**
 * The repository a connector's command comes with: a bundle whose tools
 * include it. One per command; the first followed wins.
 */
export function bundleForCommand(
  repositories: SkillRepository[],
  command: string,
): SkillRepository | undefined {
  return repositories.find(
    (repo) =>
      repo.mode === "bundle" &&
      (repo.tools ?? []).some((tool) => tool.name === command),
  );
}

/**
 * One device's line on a connector page: "feishu-cli v1.44.0 on sg-chaos ·
 * skills v1.44.0 · checked", or what is out of step.
 */
export function connectorDeviceLine(
  version: BundleDeviceVersion,
  command: string,
  deviceName: string,
  repo: Pick<SkillRepository, "rollout">,
  withStatus = true,
): string {
  return [
    i18n.t("skills:library.versions.onDevice", {
      tool: `${command} ${version.tools[command] ?? ""}`.trim(),
      device: deviceName,
    }),
    deviceSkillsText(version),
    withStatus
      ? bundleDeviceStatusLabel(bundleDeviceStatus(version, repo))
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
