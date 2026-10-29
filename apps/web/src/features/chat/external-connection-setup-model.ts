import type {
  AgentProjection,
  ExternalConnectionOffer,
  ExternalConnectionSetupDetail,
  ExternalConnectionSetupStage,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

/**
 * Setting up an external connection from the chat picker (DEV-086): which
 * connections the picker offers on this device, with one action each, and
 * the steps the setup panel shows. Pure, so the rules are testable.
 */

/** The verb each stage offers; ready is a plain option, not an action. */
function stageVerb(
  stage: Exclude<ExternalConnectionSetupStage, "ready">,
): string {
  switch (stage) {
    case "not_set_up":
      return i18n.t("connectionSetup:picker.setUp");
    case "in_progress":
      return i18n.t("connectionSetup:picker.viewProgress");
    case "waiting_sign_in":
      return i18n.t("connectionSetup:picker.finishSignIn");
    case "unchecked":
      return i18n.t("connectionSetup:picker.check");
    default:
      return i18n.t("connectionSetup:picker.retry");
  }
}

export function offerDetail(offer: ExternalConnectionOffer): string {
  const reason = offer.detail ?? "";
  switch (offer.stage) {
    case "not_set_up":
      return i18n.t("connectionSetup:picker.detail.not_set_up");
    case "in_progress":
      return i18n.t("connectionSetup:picker.detail.in_progress");
    case "waiting_sign_in":
      return i18n.t("connectionSetup:picker.detail.waiting_sign_in");
    case "unchecked":
      return i18n.t("connectionSetup:picker.detail.unchecked");
    case "check_failed":
      return reason
        ? i18n.t("connectionSetup:picker.detail.check_failed", { reason })
        : i18n.t("connectionSetup:picker.detail.check_failed_plain");
    case "setup_failed":
      return reason
        ? i18n.t("connectionSetup:picker.detail.setup_failed", { reason })
        : i18n.t("connectionSetup:picker.detail.setup_failed_plain");
    default:
      return "";
  }
}

export interface PickerSetupRow {
  profileId: string;
  label: string;
  detail: string;
  actionLabel: string;
}

/**
 * The picker rows for connections not ready on this device. A ready one is
 * already an agent option; it gets a row only while the device has not yet
 * reported it as one (so it never vanishes in between).
 */
export function pickerSetupRows(
  offers: readonly ExternalConnectionOffer[],
  agents: readonly AgentProjection[],
  deviceId: string,
): PickerSetupRow[] {
  return offers.flatMap((offer) => {
    if (offer.stage === "ready") return [];
    // A connection the device reports usable is selectable as it is.
    if (
      agents.some(
        (agent) =>
          agent.deviceId === deviceId &&
          agent.profileId === offer.profileId &&
          agent.status === "healthy",
      )
    )
      return [];
    return [
      {
        profileId: offer.profileId,
        label: offer.label,
        detail: offerDetail(offer),
        actionLabel: stageVerb(offer.stage),
      },
    ];
  });
}

/** The agent a ready connection runs as on this device, for selecting it. */
export function readyAgent(
  agents: readonly AgentProjection[],
  deviceId: string,
  profileId: string,
): AgentProjection | undefined {
  return agents.find(
    (agent) =>
      agent.deviceId === deviceId &&
      agent.profileId === profileId &&
      agent.status === "healthy",
  );
}

export type SetupStepState = "done" | "needed" | "running" | "failed";

export interface SetupStep {
  key: "run" | "installed" | "signIn" | "registered" | "checked";
  state: SetupStepState;
}

/**
 * The steps, from what the device reported. A gateway that never reports
 * progress still moves the steps on: registration and the check alone mark
 * everything before them done.
 */
export function setupSteps(
  detail: ExternalConnectionSetupDetail,
  checking: boolean,
): SetupStep[] {
  const { offer, progress, run } = detail;
  const signIn = offer.setup?.signIn !== "none";
  const keys: SetupStep["key"][] = [
    "run",
    "installed",
    ...(signIn ? (["signIn"] as const) : []),
    "registered",
    "checked",
  ];
  // How far it got: the index of the first step not done yet.
  let reached = 0;
  let failed = false;
  switch (offer.stage) {
    case "ready":
      reached = keys.length;
      break;
    case "unchecked":
      reached = keys.indexOf("checked");
      break;
    case "check_failed":
      reached = keys.indexOf("checked");
      failed = !checking;
      break;
    case "waiting_sign_in":
      reached = keys.indexOf("signIn");
      break;
    default: {
      const state = progress?.state;
      if (state === "signed_in") reached = keys.indexOf("registered");
      else if (state === "installed")
        reached = signIn ? keys.indexOf("signIn") : keys.indexOf("registered");
      else if (state === "installing") reached = keys.indexOf("installed");
      // A failed command fails the step it was working towards.
      else if (state === "failed" || offer.stage === "setup_failed")
        reached = keys.indexOf("installed");
      else reached = 0;
      failed = offer.stage === "setup_failed";
    }
  }
  const active =
    offer.stage === "in_progress" ||
    offer.stage === "waiting_sign_in" ||
    (offer.stage === "unchecked" && checking) ||
    (offer.stage === "check_failed" && checking) ||
    run?.state === "running" ||
    Boolean(progress && offer.stage === "not_set_up");
  return keys.map((key, index) => ({
    key,
    state:
      index < reached
        ? "done"
        : index === reached
          ? failed
            ? "failed"
            : active
              ? "running"
              : "needed"
          : "needed",
  }));
}

/**
 * What moved since the last look: a setup whose key stays the same for 20
 * minutes while waiting is reported as stalled.
 */
export function setupProgressKey(
  detail: ExternalConnectionSetupDetail,
): string {
  return [
    detail.offer.stage,
    detail.progress?.state ?? "",
    detail.progress?.updatedAt ?? "",
    detail.run?.runId ?? "",
    detail.run?.state ?? "",
    detail.run?.nextOffset ?? "",
  ].join("|");
}

export const setupStallMs = 20 * 60_000;

export function setupWaiting(stage: ExternalConnectionSetupStage): boolean {
  return (
    stage === "not_set_up" ||
    stage === "in_progress" ||
    stage === "waiting_sign_in"
  );
}
