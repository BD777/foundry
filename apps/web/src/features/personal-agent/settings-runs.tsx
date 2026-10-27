import { toast } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentRunControl,
  PersonalAgentRunSnapshot,
  WorkspaceProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import {
  listPersonalAgentRunControls,
  listPersonalAgentRunSnapshots,
  stopPersonalAgentRun,
} from "../../api";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { SettingsGroup } from "./settings-field";
export function RoleRuns({
  workspaces,
  devices,
}: {
  workspaces: WorkspaceProjection[];
  devices: DeviceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const [runs, setRuns] = useState<PersonalAgentRunControl[]>([]);
  const [snapshots, setSnapshots] = useState<PersonalAgentRunSnapshot[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const read = useCallback(async () => {
    const [controls, configs] = await Promise.all([
      listPersonalAgentRunControls(),
      listPersonalAgentRunSnapshots(),
    ]);
    setRuns(controls);
    setSnapshots(configs);
  }, []);
  useEffect(() => {
    void read().catch((e) => setError(serverErrorText(e)));
  }, [read]);
  const active = runs.some(
    (r) => r.state === "monitoring" || r.state === "stop_requested",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => void read().catch((e) => setError(serverErrorText(e))),
      5000,
    );
    return () => clearInterval(timer);
  }, [active, read]);
  async function stop(run: PersonalAgentRunControl) {
    setBusy(run.id);
    setError("");
    try {
      await stopPersonalAgentRun(run.id);
      await read();
    } catch (e) {
      toast({
        tone: "error",
        title: t("runs.failed"),
        description: serverErrorText(e),
      });
    } finally {
      setBusy("");
    }
  }
  return (
    <SettingsGroup title={t("runs.title")}>
      <FieldHint>{t("runs.boundaries")}</FieldHint>
      <FieldHint>{t("runs.budgetHint")}</FieldHint>
      {error ? (
        <Alert tone="error" title={t("runs.failed")}>
          {error}
        </Alert>
      ) : null}
      <Button
        size="sm"
        onClick={() => void read().catch((e) => setError(serverErrorText(e)))}
      >
        {t("runs.refresh")}
      </Button>
      <ul className="fdy-pa-memory">
        {[
          ...runs.filter((r) =>
            ["monitoring", "stop_requested"].includes(r.state),
          ),
          ...runs
            .filter((r) => !["monitoring", "stop_requested"].includes(r.state))
            .slice(0, 30),
        ].map((run) => {
          const snapshot = snapshots.find((s) => s.id === run.snapshotId);
          const state =
            run.state === "monitoring"
              ? t("runs.monitoring")
              : run.state === "stop_requested"
                ? t("runs.stopRequested")
                : run.state === "stopped"
                  ? t("runs.stopped")
                  : run.state === "input_moved"
                    ? t("runs.inputMoved")
                    : t("runs.settled");
          return (
            <li key={run.id} className="fdy-pa-memory-item">
              <p>
                {run.role} · {state}
              </p>
              {run.waitingReason ? (
                <FieldHint>
                  {t(`runs.waitReasons.${run.waitingReason}` as never, {
                    defaultValue: run.waitingReason,
                  })}
                </FieldHint>
              ) : null}
              {snapshot ? (
                <>
                  <FieldHint>
                    {t("runs.configuration", {
                      account: snapshot.profileId,
                      model: snapshot.model || t("runs.defaultValue"),
                      effort: snapshot.effort || t("runs.defaultValue"),
                      device:
                        devices.find((d) => d.id === snapshot.deviceId)
                          ?.label ?? snapshot.deviceId,
                      workspace:
                        workspaces.find((w) => w.id === snapshot.workspaceId)
                          ?.name ?? snapshot.workspaceId,
                    })}
                  </FieldHint>
                  <FieldHint>{t("runs.requestedOnly")}</FieldHint>
                </>
              ) : null}
              <FieldHint>
                {t("runs.usage", {
                  tokens: run.observedTokens,
                  budget: run.tokenBudget,
                  state: run.usageState,
                  minutes: run.timeoutMinutes,
                })}
              </FieldHint>
              {run.stopReason ? (
                <p>{t("runs.reason", { reason: run.stopReason })}</p>
              ) : null}
              <div className="fdy-pa-inline">
                <Button
                  size="sm"
                  onClick={() =>
                    navigateToChat(run.sessionId, snapshot?.workspaceId)
                  }
                >
                  {t("runs.open")}
                </Button>
                <Button
                  size="sm"
                  disabled={Boolean(busy) || run.state !== "monitoring"}
                  onClick={() => void stop(run)}
                >
                  {run.state === "stop_requested"
                    ? t("runs.stopRequested")
                    : t("runs.stopInput")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {runs.length === 0 ? (
        <p className="fdy-pa-muted">{t("runs.empty")}</p>
      ) : null}
    </SettingsGroup>
  );
}
