import { Alert } from "../../components/ui/alert";
import { DeviceSection } from "./device-section";
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
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { errorText } from "../../lib/errors";
import { useCopied } from "../../lib/use-copied";
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

const lineClass = "m-0 text-sm wrap-anywhere text-ink-muted";
const groupClass =
  "grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-line pt-3";

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
  const { copied, copy, reset: resetCopied } = useCopied();
  const [repairing, setRepairing] = useState<DeviceRepairAction>();
  const [repairNote, setRepairNote] = useState<{
    text: string;
    tone: "info" | "error";
  }>();

  const run = async () => {
    setRunning(true);
    setError("");
    resetCopied();
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
    setRepairNote(undefined);
    try {
      const result = await runDeviceRepair(device.id, action);
      setRepairNote({
        text: t(`diagnostics.repair.done.${action}`, {
          count: Number(result.values?.count ?? 0),
        }),
        tone: "info",
      });
      await onRefresh().catch(() => {});
      if (report) await run();
    } catch (cause) {
      setRepairNote({ text: errorText(cause), tone: "error" });
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
    <DeviceSection className="grid-cols-[minmax(0,1fr)] gap-3">
      <SectionHeader
        title={t("diagnostics.title")}
        description={t("diagnostics.intro")}
        help={
          <HelpHint label={t("diagnostics.introHelpLabel")}>
            {t("diagnostics.introHelp")}
          </HelpHint>
        }
        actions={
          <>
            {report ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void copy(reportText(device.label, report))}
              >
                {copied() ? t("common:actions.copied") : t("diagnostics.copy")}
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
          </>
        }
      />
      <p className={lineClass}>
        {device.lastDisconnect
          ? t("diagnostics.lastDisconnect", {
              line: disconnectLine(device.lastDisconnect),
            })
          : t("diagnostics.noDisconnect")}
      </p>
      {!online ? (
        <Alert size="compact" title={t("diagnostics.offline")} />
      ) : null}
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      {running && !report ? (
        <Alert size="compact" title={t("diagnostics.runningNotice")} />
      ) : null}
      {report ? (
        <>
          <p className={lineClass}>
            {t("diagnostics.generated", {
              version: report.workerVersion,
              at: time(report.generatedAt),
            })}
          </p>
          {groups.map((group) =>
            grouped(group).length ? (
              <div className={groupClass} key={group}>
                <h3 className="m-0 text-md">
                  {t(`diagnostics.group.${group}`)}
                </h3>
                <ul className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-2.5 p-0">
                  {grouped(group).map((check) => {
                    const text = checkText(check);
                    return (
                      <li
                        className="col-span-full grid grid-cols-subgrid items-start gap-2.5 [&>:first-child]:justify-self-start"
                        key={check.id}
                      >
                        <Badge tone={tones[check.status]}>
                          {t(`diagnostics.status.${check.status}`)}
                        </Badge>
                        <span className="grid min-w-0 gap-0.5 text-sm wrap-anywhere">
                          <strong>{text.title}</strong>
                          <span>{text.detail}</span>
                          {text.advice ? (
                            <small className="text-xs text-ink-muted">
                              {text.advice}
                            </small>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null,
          )}
          {report.logTail.length ? (
            <details className="min-w-0 open:[&>summary]:mb-2">
              <summary className="cursor-pointer text-sm text-ink-muted">
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
      <div className={groupClass}>
        <div className="flex items-center gap-1.5">
          <h3 className="m-0 text-md">{t("diagnostics.repair.title")}</h3>
          <HelpHint label={t("diagnostics.repair.helpLabel")}>
            {t("diagnostics.repair.intro")}
          </HelpHint>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          {report?.checks.some(
            (c) => c.id === "runtime.sandbox" && c.status !== "ok",
          ) ? (
            <ConfirmButton
              confirmLabel={t("diagnostics.repair.confirm.install-bubblewrap")}
              disabled={!online || Boolean(repairing)}
              onConfirm={() => void repair("install-bubblewrap")}
              size="sm"
              variant="secondary"
            >
              {t("diagnostics.repair.action.install-bubblewrap")}
            </ConfirmButton>
          ) : null}
        </div>
        {repairing ? (
          <Alert size="compact" title={t("diagnostics.repair.running")} />
        ) : null}
        {repairNote ? (
          <Alert
            size="compact"
            tone={repairNote.tone}
            title={repairNote.text}
          />
        ) : null}
      </div>
    </DeviceSection>
  );
}
