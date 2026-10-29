import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProjection,
  ExternalConnectionSetupDetail,
} from "@bd777/foundry-protocol";
import {
  cancelExternalConnectionSetup,
  checkExternalConnection,
  getExternalConnectionSetup,
  startExternalConnectionSetup,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import {
  SetupChecklist,
  SetupChecklistItem,
} from "../../components/ui/setup-checklist";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { serverErrorText } from "../../lib/errors";
import { dateTime } from "../../lib/time-format";
import { useCopied } from "../../lib/use-copied";
import { useSharedNow } from "../../lib/use-shared-now";
import { i18n } from "../../i18n";
import {
  readyAgent,
  type SetupStep,
  setupProgressKey,
  setupStallMs,
  setupSteps,
  setupWaiting,
} from "./external-connection-setup-model";

export interface ExternalConnectionSetupDialogProps {
  agents: readonly AgentProjection[];
  deviceId: string;
  profileId: string;
  onClose: () => void;
  /** Selects the connection for the open chat once it is ready. */
  onSelectAgent: (agentId: string) => void;
}

interface RunOutput {
  runId: string;
  text: string;
  after: number;
  truncated: boolean;
}

/**
 * Sets an external connection up on the workspace's device (DEV-086): the
 * gateway's command to copy and run there, or "Set it up for me" where the
 * device allows remote commands; then its progress, read from the device,
 * until the connection is registered, checked once and selected.
 */
export function ExternalConnectionSetupDialog({
  agents,
  deviceId,
  profileId,
  onClose,
  onSelectAgent,
}: ExternalConnectionSetupDialogProps) {
  const { t } = useTranslation("connectionSetup");
  const [detail, setDetail] = useState<ExternalConnectionSetupDetail>();
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [output, setOutput] = useState<RunOutput>();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkTried, setCheckTried] = useState(false);
  const [selected, setSelected] = useState("");
  const [lastChange, setLastChange] = useState(() => Date.now());
  const [dismissedFailure, setDismissedFailure] = useState("");
  const progressKey = useRef("");
  const outputRef = useRef<RunOutput | undefined>(undefined);
  outputRef.current = output;
  // Starting a run makes answers to reads sent before it stale.
  const generation = useRef(0);
  const now = useSharedNow(true);

  const load = useCallback(async () => {
    const tracked = outputRef.current;
    const asked = generation.current;
    try {
      const next = await getExternalConnectionSetup(
        deviceId,
        profileId,
        tracked ? { runId: tracked.runId, after: tracked.after } : undefined,
      );
      if (asked !== generation.current) return undefined;
      setDetail(next);
      setLoadError("");
      const key = setupProgressKey(next);
      if (key !== progressKey.current) {
        progressKey.current = key;
        setLastChange(Date.now());
      }
      const run = next.run;
      if (run) {
        setOutput((current) =>
          current?.runId === run.runId && run.offset === current.after
            ? {
                ...current,
                text: current.text + run.output,
                after: run.nextOffset,
                truncated: current.truncated || Boolean(run.truncated),
              }
            : current?.runId === run.runId
              ? current
              : {
                  runId: run.runId,
                  text: run.output,
                  after: run.nextOffset,
                  truncated: Boolean(run.truncated),
                },
        );
      }
      return next;
    } catch (error) {
      setLoadError(serverErrorText(error));
      return undefined;
    }
  }, [deviceId, profileId]);

  // Follow the device while the panel is open: quickly while something
  // runs or waits, slowly once it is ready.
  const stage = detail?.offer.stage;
  const runRunning = detail?.run?.state === "running";
  useEffect(() => {
    let current = true;
    let timer: number | undefined;
    const tick = async () => {
      await load();
      if (!current) return;
      timer = window.setTimeout(
        tick,
        stage === "ready" && !runRunning ? 10_000 : 2000,
      );
    };
    void tick();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [load, stage, runRunning]);

  // Registered: check it once, as the panel says (the person started this).
  useEffect(() => {
    if (stage !== "unchecked" || checkTried || checking) return;
    setCheckTried(true);
    void runCheck();
    // runCheck reads only stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, checkTried, checking]);

  async function runCheck() {
    setChecking(true);
    setActionError("");
    try {
      await checkExternalConnection(deviceId, profileId);
    } catch (error) {
      setActionError(serverErrorText(error));
    } finally {
      setChecking(false);
      await load();
    }
  }

  // Ready: select it for this chat, once the device lists it as an agent.
  const agent =
    stage === "ready" ? readyAgent(agents, deviceId, profileId) : undefined;
  useEffect(() => {
    if (!agent || selected) return;
    setSelected(agent.id);
    onSelectAgent(agent.id);
  }, [agent, selected, onSelectAgent]);

  async function runForMe() {
    if (!detail?.offer.setupDigest) return;
    setStarting(true);
    setActionError("");
    setDismissedFailure(failureKey(detail));
    try {
      const { run } = await startExternalConnectionSetup(
        deviceId,
        profileId,
        detail.offer.setupDigest,
      );
      generation.current += 1;
      outputRef.current = {
        runId: run.runId,
        text: run.output,
        after: run.nextOffset,
        truncated: false,
      };
      setOutput({
        runId: run.runId,
        text: run.output,
        after: run.nextOffset,
        truncated: false,
      });
      setLastChange(Date.now());
      await load();
    } catch (error) {
      setActionError(serverErrorText(error));
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    if (!detail?.run) return;
    setStopping(true);
    try {
      await cancelExternalConnectionSetup(
        deviceId,
        profileId,
        detail.run.runId,
      );
      await load();
    } catch (error) {
      setActionError(serverErrorText(error));
    } finally {
      setStopping(false);
    }
  }

  const device = detail?.device.label ?? "";
  const title = detail
    ? t("dialog.title", { label: detail.offer.label, device })
    : t("dialog.title", { label: profileId, device: "…" });
  const ready = stage === "ready";

  return (
    <Dialog
      title={title}
      description={t("dialog.description")}
      onClose={onClose}
      size="wide"
      footer={
        <Button variant={ready ? "primary" : "secondary"} onClick={onClose}>
          {ready ? t("dialog.done") : t("dialog.close")}
        </Button>
      }
    >
      {!detail ? (
        loadError ? (
          <Alert
            tone="error"
            title={t("dialog.loadFailed", { error: loadError })}
          />
        ) : (
          <LoadingState label={t("steps.title")} />
        )
      ) : (
        <SetupBody
          detail={detail}
          output={output}
          now={now}
          lastChange={lastChange}
          checking={checking}
          starting={starting}
          stopping={stopping}
          actionError={actionError}
          loadError={loadError}
          selected={Boolean(selected)}
          dismissedFailure={dismissedFailure}
          onRetry={() => {
            setDismissedFailure(failureKey(detail));
            setLastChange(Date.now());
            if (stage === "check_failed") void runCheck();
            else if (detail.remote.available && detail.run) void runForMe();
          }}
          onRunForMe={() => void runForMe()}
          onStop={() => void stopRun()}
        />
      )}
    </Dialog>
  );
}

function failureKey(detail: ExternalConnectionSetupDetail): string {
  return `${detail.offer.stage}|${detail.progress?.updatedAt ?? ""}|${detail.run?.runId ?? ""}|${detail.run?.state ?? ""}`;
}

function SetupBody({
  detail,
  output,
  now,
  lastChange,
  checking,
  starting,
  stopping,
  actionError,
  loadError,
  selected,
  dismissedFailure,
  onRetry,
  onRunForMe,
  onStop,
}: {
  detail: ExternalConnectionSetupDetail;
  output?: RunOutput;
  now: number;
  lastChange: number;
  checking: boolean;
  starting: boolean;
  stopping: boolean;
  actionError: string;
  loadError: string;
  selected: boolean;
  dismissedFailure: string;
  onRetry: () => void;
  onRunForMe: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation("connectionSetup");
  const { offer, device, progress, run, remote } = detail;
  const setup = offer.setup;
  const deviceName = device.label;
  const running = run?.state === "running";
  const stage = offer.stage;
  // A failed run matters only until the connection is registered.
  const failed =
    (stage === "setup_failed" ||
      (setupWaiting(stage) &&
        run !== undefined &&
        !running &&
        run.state !== "succeeded")) &&
    failureKey(detail) !== dismissedFailure;
  const stalled =
    setupWaiting(stage) && !failed && now - lastChange > setupStallMs;
  const steps = setupSteps(detail, checking);
  const runFailure = run
    ? run.state === "timed_out"
      ? t("failure.timedOut")
      : run.state === "cancelled"
        ? t("failure.cancelled")
        : run.state === "failed" && run.exitCode !== undefined
          ? t("failure.exit", { code: run.exitCode })
          : ""
    : "";

  return (
    <div className="fdy-connection-setup">
      {setup ? (
        <section className="fdy-connection-setup-command">
          <p className="fdy-connection-setup-text">
            {device.user
              ? t("dialog.runAs", { device: deviceName, user: device.user })
              : t("dialog.runAsUnknown", { device: deviceName })}
          </p>
          <TerminalBlock
            lines={[{ id: "setup", prompt: "$", value: setup.command }]}
          />
          <FieldHint>
            {offer.setupSource && setup.registeredAt
              ? t("dialog.provenance", {
                  source: offer.setupSource.label,
                  time: dateTime(setup.registeredAt),
                  id: offer.profileId,
                })
              : t("dialog.provenanceNoTime", {
                  source: offer.setupSource?.label ?? deviceName,
                  id: offer.profileId,
                })}
          </FieldHint>
          <div className="fdy-connection-setup-actions">
            <CommandCopy command={setup.command} />
            {setup.url ? (
              <Button asChild size="sm" variant="ghost">
                <a href={setup.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={13} aria-hidden="true" />
                  {t("dialog.gatewayLink")}
                </a>
              </Button>
            ) : null}
          </div>
          {offer.otherSetups?.length ? (
            <Alert
              tone="warning"
              size="compact"
              title={t("dialog.otherSetups")}
            >
              <details className="fdy-connection-setup-others">
                <summary>{t("dialog.showOtherSetups")}</summary>
                {offer.otherSetups.map((other) => (
                  <div key={other.deviceId}>
                    <p className="fdy-connection-setup-text">
                      {t("dialog.otherSetupFrom", {
                        device: other.label,
                        time: other.registeredAt
                          ? dateTime(other.registeredAt)
                          : "",
                      })}
                    </p>
                    <TerminalBlock
                      lines={[
                        {
                          id: other.deviceId,
                          prompt: "$",
                          value: other.command,
                        },
                      ]}
                    />
                  </div>
                ))}
              </details>
            </Alert>
          ) : null}
          {!(
            setupWaiting(stage) ||
            stage === "setup_failed" ||
            running
          ) ? null : (
            <div className="fdy-connection-setup-remote">
              {running ? (
                <>
                  <LoadingState
                    className="fdy-connection-setup-remote-text"
                    label={t("remote.running", { device: deviceName })}
                  />
                  <Button size="sm" busy={stopping} onClick={onStop}>
                    {t("remote.stop")}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={starting}
                    disabled={!remote.available}
                    onClick={onRunForMe}
                  >
                    {t("remote.run")}
                  </Button>
                  <FieldHint
                    as="span"
                    className="fdy-connection-setup-remote-text"
                  >
                    {remote.available
                      ? t("remote.hint", { device: deviceName })
                      : remote.reason === "old_worker"
                        ? t("remote.unavailable.old_worker", {
                            device: deviceName,
                          })
                        : remote.reason === "remote_commands_off"
                          ? t("remote.unavailable.remote_commands_off", {
                              device: deviceName,
                            })
                          : t("remote.unavailable.offline", {
                              device: deviceName,
                            })}
                  </FieldHint>
                </>
              )}
            </div>
          )}
        </section>
      ) : stage === "ready" ? null : (
        <Alert
          tone="info"
          size="compact"
          title={t("dialog.noCommand", { device: deviceName })}
        />
      )}

      <section className="fdy-connection-setup-progress">
        <h3 className="fdy-connection-setup-heading">{t("steps.title")}</h3>
        <SetupChecklist label={t("steps.title")}>
          {steps.map((step) => (
            <SetupChecklistItem
              key={step.key}
              state={step.state}
              title={stepTitle(step.key, step.state, checking)}
              detail={
                step.key === "signIn" && stage === "waiting_sign_in" ? (
                  <>
                    {t("signIn.hint")}
                    {progress?.userCode ? (
                      <>
                        {" "}
                        <strong className="fdy-connection-setup-code">
                          {t("signIn.code", { code: progress.userCode })}
                        </strong>
                      </>
                    ) : null}
                  </>
                ) : step.key === "checked" && step.state === "needed" ? (
                  t("check.note")
                ) : step.key === "checked" && stage === "check_failed" ? (
                  offer.detail
                ) : undefined
              }
              action={
                step.key === "signIn" &&
                stage === "waiting_sign_in" &&
                progress?.signInUrl ? (
                  <Button asChild size="sm" variant="primary">
                    <a
                      href={progress.signInUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {t("signIn.open")}
                    </a>
                  </Button>
                ) : step.key === "checked" && stage === "check_failed" ? (
                  <Button size="sm" busy={checking} onClick={onRetry}>
                    {t("check.retry")}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </SetupChecklist>
      </section>

      {stage === "ready" ? (
        <Alert
          tone="success"
          size="compact"
          title={
            selected ? t("dialog.success") : t("dialog.successNotSelected")
          }
        />
      ) : null}
      {failed ? (
        <Alert
          tone="error"
          size="compact"
          title={t("failure.setup")}
          details={undefined}
        >
          {progress?.state === "failed" && progress.message ? (
            <p>{progress.message}</p>
          ) : null}
          {runFailure ? <p>{runFailure}</p> : null}
          <Button size="sm" onClick={onRetry}>
            {t("failure.retry")}
          </Button>
        </Alert>
      ) : null}
      {stalled ? (
        <Alert tone="warning" size="compact" title={t("stalled.title")}>
          <p>{t("stalled.body", { device: deviceName })}</p>
          <Button size="sm" onClick={onRetry}>
            {t("failure.retry")}
          </Button>
        </Alert>
      ) : null}
      {actionError ? (
        <Alert tone="error" size="compact" title={actionError} />
      ) : null}
      {loadError ? (
        <Alert
          tone="warning"
          size="compact"
          title={t("dialog.loadFailed", { error: loadError })}
        />
      ) : null}
      {output ? (
        <details
          className="fdy-connection-setup-log"
          open={failed || undefined}
        >
          <summary>{t("log.show")}</summary>
          {output.truncated ? (
            <FieldHint>{t("log.truncated")}</FieldHint>
          ) : null}
          <TerminalBlock
            className="fdy-connection-setup-log-lines"
            lines={(output.text || t("log.empty"))
              .split("\n")
              .map((line, index) => ({ id: String(index), value: line }))}
          />
        </details>
      ) : null}
    </div>
  );
}

function stepTitle(
  key: SetupStep["key"],
  state: SetupStep["state"],
  checking: boolean,
): string {
  switch (key) {
    case "run":
      return state === "done"
        ? i18n.t("connectionSetup:steps.runDone")
        : i18n.t("connectionSetup:steps.run");
    case "installed":
      return i18n.t("connectionSetup:steps.installed");
    case "signIn":
      return state === "done"
        ? i18n.t("connectionSetup:steps.signedIn")
        : i18n.t("connectionSetup:steps.signIn");
    case "registered":
      return i18n.t("connectionSetup:steps.registered");
    default:
      return checking
        ? i18n.t("connectionSetup:steps.checking")
        : state === "failed"
          ? i18n.t("connectionSetup:steps.checkFailed")
          : state === "done"
            ? i18n.t("connectionSetup:steps.checked")
            : i18n.t("connectionSetup:steps.check");
  }
}

function CommandCopy({ command }: { command: string }) {
  const { t } = useTranslation("connectionSetup");
  const { copied, copy } = useCopied(1200);
  return (
    <Button size="sm" onClick={() => void copy(command)}>
      {copied() ? t("dialog.copied") : t("dialog.copy")}
    </Button>
  );
}
