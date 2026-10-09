import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceDiagnostics as DiagnosticsReport,
  DeviceProjection,
  DeviceRepairAction,
  DiagnosticCheck,
} from "@bd777/foundry-protocol";
import { runDeviceDiagnostics, runDeviceRepair } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { TerminalBlock } from "../../components/ui/terminal-block";
import {
  checkText,
  disconnectLine,
  reportText,
  time,
} from "./device-diagnostics-text";

const groups = [
  "connection",
  "runtime",
  "agents",
  "workspaces",
  "skills",
  "chats",
] as const;
const tones = {
  ok: "online",
  info: "neutral",
  warn: "warn",
  error: "error",
} as const;

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The device's own account of its health: the last drop, a report the worker
 * makes on request, and repairs a person may run. Nothing here runs by itself.
 */
export function DeviceDiagnostics({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const [report, setReport] = useState<DiagnosticsReport>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState<DeviceRepairAction>();
  const [repairNote, setRepairNote] = useState("");

  const run = async () => {
    setRunning(true);
    setError("");
    setCopied(false);
    try {
      setReport(await runDeviceDiagnostics(device.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunning(false);
    }
  };

  const repair = async (action: DeviceRepairAction) => {
    setRepairing(action);
    setRepairNote("");
    try {
      const result = await runDeviceRepair(device.id, action);
      setRepairNote(
        t(`diagnostics.repair.done.${action}`, {
          count: Number(result.values?.count ?? 0),
        }),
      );
      await onRefresh().catch(() => {});
      if (report) await run();
    } catch (cause) {
      setRepairNote(errorText(cause));
    } finally {
      setRepairing(undefined);
    }
  };

  const grouped = (group: (typeof groups)[number]): DiagnosticCheck[] =>
    report?.checks.filter((check) => check.id.split(".")[0] === group) ?? [];
  const missing = Number(
    report?.checks.find((check) => check.id === "workspaces.missing")?.values
      ?.count ?? 0,
  );
  const online = device.status === "connected";

  return (
    <section className="fdy-device-section fdy-device-diagnostics">
      <header className="fdy-device-diagnostics-heading">
        <div>
          <h2>{t("diagnostics.title")}</h2>
          <p>{t("diagnostics.intro")}</p>
        </div>
        <div className="fdy-device-diagnostics-actions">
          {report ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard
                  .writeText(reportText(device.label, report))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? t("common:actions.copied") : t("diagnostics.copy")}
            </Button>
          ) : null}
          <Button
            aria-busy={running}
            disabled={running || !online}
            onClick={() => void run()}
            size="sm"
            variant="primary"
          >
            {running ? t("diagnostics.running") : t("diagnostics.run")}
          </Button>
        </div>
      </header>
      <p className="fdy-device-diagnostics-note">
        {device.lastDisconnect
          ? t("diagnostics.lastDisconnect", {
              line: disconnectLine(device.lastDisconnect),
            })
          : t("diagnostics.noDisconnect")}
      </p>
      {!online ? (
        <p className="fdy-device-diagnostics-note" role="note">
          {t("diagnostics.offline")}
        </p>
      ) : null}
      {error ? (
        <p className="fdy-location-error" role="alert">
          {error}
        </p>
      ) : null}
      {running && !report ? (
        <p className="fdy-device-diagnostics-note" role="status">
          {t("diagnostics.runningNote")}
        </p>
      ) : null}
      {report ? (
        <>
          <p className="fdy-device-diagnostics-note">
            {t("diagnostics.generated", {
              version: report.workerVersion,
              at: time(report.generatedAt),
            })}
          </p>
          {groups.map((group) =>
            grouped(group).length ? (
              <div className="fdy-device-diagnostics-group" key={group}>
                <h3>{t(`diagnostics.group.${group}`)}</h3>
                <ul>
                  {grouped(group).map((check) => {
                    const text = checkText(check);
                    return (
                      <li key={check.id}>
                        <Badge tone={tones[check.status]}>
                          {t(`diagnostics.status.${check.status}`)}
                        </Badge>
                        <span className="fdy-device-diagnostics-copy">
                          <strong>{text.title}</strong>
                          <span>{text.detail}</span>
                          {text.advice ? <small>{text.advice}</small> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null,
          )}
          {report.logTail.length ? (
            <details className="fdy-device-diagnostics-log">
              <summary>
                {t("diagnostics.log", { count: report.logTail.length })}
              </summary>
              <TerminalBlock
                lines={report.logTail.map((line, index) => ({
                  id: String(index),
                  value: line,
                }))}
              />
            </details>
          ) : null}
        </>
      ) : null}
      <div className="fdy-device-diagnostics-group">
        <h3>{t("diagnostics.repair.title")}</h3>
        <p className="fdy-device-diagnostics-note">
          {t("diagnostics.repair.intro")}
        </p>
        <div className="fdy-device-diagnostics-actions">
          <ConfirmButton
            confirmLabel={t(
              "diagnostics.repair.confirm.forget-missing-workspaces",
            )}
            disabled={!online || Boolean(repairing)}
            onConfirm={() => void repair("forget-missing-workspaces")}
            size="sm"
            variant="secondary"
          >
            {missing
              ? t("diagnostics.repair.forgetCount", { count: missing })
              : t("diagnostics.repair.action.forget-missing-workspaces")}
          </ConfirmButton>
          <ConfirmButton
            confirmLabel={t(
              "diagnostics.repair.confirm.clear-skill-scan-cache",
            )}
            disabled={!online || Boolean(repairing)}
            onConfirm={() => void repair("clear-skill-scan-cache")}
            size="sm"
            variant="secondary"
          >
            {t("diagnostics.repair.action.clear-skill-scan-cache")}
          </ConfirmButton>
          <ConfirmButton
            confirmLabel={t("diagnostics.repair.confirm.recheck-agents")}
            disabled={!online || Boolean(repairing)}
            onConfirm={() => void repair("recheck-agents")}
            size="sm"
            variant="secondary"
          >
            {t("diagnostics.repair.action.recheck-agents")}
          </ConfirmButton>
        </div>
        {repairing ? (
          <p role="status">{t("diagnostics.repair.running")}</p>
        ) : null}
        {repairNote ? (
          <p className="fdy-device-diagnostics-note" role="status">
            {repairNote}
          </p>
        ) : null}
      </div>
    </section>
  );
}
