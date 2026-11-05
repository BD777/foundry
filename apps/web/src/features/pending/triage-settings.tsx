import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Sparkles } from "lucide-react";
import type {
  AgentProfileProjection,
  ClaudeEffort,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import {
  getPendingTriage,
  savePendingTriage,
  type PendingTriageSettings,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { CheckLabel } from "../../components/ui/check-label";
import { Dialog } from "../../components/ui/dialog";
import { Checkbox, FieldHint } from "../../components/ui/field";
import { FormFieldGroup, FormLayout } from "../../components/ui/form-field";
import { SelectMenu } from "../../components/ui/select-menu";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { useProfileModels } from "../../components/workspace/agent-default-fields";
import {
  claudeEffortOptions,
  codexEffortOptions,
  effortLabel,
} from "../../lib/agent-effort";
import { ownedDeviceCandidates } from "../../lib/devices";

/**
 * The Pending page's choice of what reads answers for what they ask
 * (DEV-125): a header button saying what is chosen, opening the dialog
 * that chooses it.
 */
export function TriageSettingsButton({
  devices,
  agentProfiles,
}: {
  devices: DeviceProjection[];
  agentProfiles: AgentProfileProjection[];
}) {
  const { t } = useTranslation("pending");
  const [settings, setSettings] = useState<PendingTriageSettings | null>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getPendingTriage().then(
      (read) => {
        if (!cancelled) setSettings(read);
      },
      () => {
        if (!cancelled) setSettings(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (settings === undefined) return null;
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="sm"
        title={t("triage.description")}
        variant="ghost"
      >
        <Sparkles aria-hidden="true" size={14} />
        {settings?.enabled
          ? t("page.triageOn", {
              model: settings.model || t("triage.modelDefault"),
              effort: settings.effort
                ? effortLabel(settings.effort as ClaudeEffort)
                : t("triage.effortDefault"),
            })
          : t("page.triageOff")}
        <ChevronRight aria-hidden="true" size={14} />
      </Button>
      {open ? (
        <TriageSettingsDialog
          agentProfiles={agentProfiles}
          devices={devices}
          initial={settings ?? { enabled: false }}
          loadFailed={settings === null}
          onClose={() => setOpen(false)}
          onSaved={(saved) => {
            setSettings(saved);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function TriageSettingsDialog({
  devices,
  agentProfiles,
  initial,
  loadFailed,
  onClose,
  onSaved,
}: {
  devices: DeviceProjection[];
  agentProfiles: AgentProfileProjection[];
  initial: PendingTriageSettings;
  loadFailed: boolean;
  onClose: () => void;
  onSaved: (saved: PendingTriageSettings) => void;
}) {
  const { t } = useTranslation("pending");
  const [draft, setDraft] = useState<PendingTriageSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<PendingTriageSettings>) =>
    setDraft((current) => ({ ...current, ...next }));

  const owned = ownedDeviceCandidates(devices);
  const connections = agentProfiles.filter(
    (profile) => profile.deviceId === draft.deviceId,
  );
  const connection = connections.find(
    (profile) => profile.id === draft.profileId,
  );
  const { models, loading } = useProfileModels(connection);
  const efforts =
    draft.runtime === "codex" ? codexEffortOptions() : claudeEffortOptions();
  const ready = !draft.enabled || Boolean(draft.deviceId && connection);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(await savePendingTriage(draft));
    } catch (failure) {
      setError(
        t("triage.failed", {
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      description={t("triage.description")}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">
            {t("triage.cancel")}
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => void save()}
            variant="primary"
          >
            {t("triage.save")}
          </Button>
        </>
      }
      layout="compact"
      onClose={onClose}
      title={t("triage.title")}
    >
      <FormLayout>
        {loadFailed ? (
          <Alert size="compact" title={t("triage.loadFailed")} tone="error" />
        ) : null}
        <CheckLabel>
          <Checkbox
            checked={draft.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span>
            {t("triage.enabled")}
            <FieldHint as="small">{t("triage.enabledHint")}</FieldHint>
          </span>
        </CheckLabel>
        <FormFieldGroup>
          <span>{t("triage.device")}</span>
          <SelectMenu
            ariaLabel={t("triage.device")}
            disabled={!draft.enabled}
            insideDialog
            onChange={(deviceId) =>
              patch({
                deviceId,
                profileId: "",
                runtime: "",
                model: "",
                effort: "",
              })
            }
            options={[
              { value: "", label: t("triage.chooseDevice") },
              ...owned.map((device) => ({
                value: device.id,
                label:
                  device.status === "connected"
                    ? device.label
                    : t("triage.offline", { name: device.label }),
              })),
            ]}
            value={draft.deviceId ?? ""}
          />
          <FieldHint as="small">{t("triage.deviceHint")}</FieldHint>
        </FormFieldGroup>
        <FormFieldGroup>
          <span>{t("triage.connection")}</span>
          <SelectMenu
            ariaLabel={t("triage.connection")}
            disabled={!draft.enabled || !draft.deviceId}
            insideDialog
            onChange={(profileId) => {
              const chosen = connections.find(
                (profile) => profile.id === profileId,
              );
              patch({
                profileId,
                runtime: chosen?.runtime ?? "",
                model: "",
                effort: "",
              });
            }}
            options={[
              { value: "", label: t("triage.chooseConnection") },
              ...connections.map((profile) => ({
                value: profile.id,
                label:
                  profile.status === "healthy"
                    ? profile.label
                    : t("triage.unavailable", { name: profile.label }),
                meta: runtimeMeta(profile.runtime).label,
              })),
            ]}
            value={draft.profileId ?? ""}
          />
          {draft.deviceId && connections.length === 0 ? (
            <FieldHint as="small" tone="warning">
              {t("triage.noConnections")}
            </FieldHint>
          ) : null}
        </FormFieldGroup>
        <FormFieldGroup>
          <span>{t("triage.model")}</span>
          <SelectMenu
            ariaLabel={t("triage.model")}
            disabled={!draft.enabled || !connection}
            insideDialog
            onChange={(model) => patch({ model })}
            options={[
              { value: "", label: t("triage.modelDefault") },
              ...[
                ...new Set([...models, ...(draft.model ? [draft.model] : [])]),
              ].map((model) => ({ value: model, label: model })),
            ]}
            value={draft.model ?? ""}
          />
          {loading ? (
            <FieldHint as="small">{t("triage.modelsLoading")}</FieldHint>
          ) : null}
        </FormFieldGroup>
        <FormFieldGroup>
          <span>{t("triage.effort")}</span>
          <SelectMenu
            ariaLabel={t("triage.effort")}
            disabled={!draft.enabled || !connection}
            insideDialog
            onChange={(effort) => patch({ effort })}
            options={[
              { value: "", label: t("triage.effortDefault") },
              ...efforts.map((option) => ({
                value: option.value,
                label: option.label,
              })),
            ]}
            value={draft.effort ?? ""}
          />
          <FieldHint as="small">{t("triage.effortHint")}</FieldHint>
        </FormFieldGroup>
        {error ? <Alert size="compact" title={error} tone="error" /> : null}
      </FormLayout>
    </Dialog>
  );
}
