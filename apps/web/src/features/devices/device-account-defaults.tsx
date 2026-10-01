import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import type { CreateAgentProfileInput } from "../../api-types";
import { createAgentProfile, listAgentModels } from "../../api";
import { Button } from "../../components/ui/button";
import { ModelCombobox } from "../../components/ui/model-combobox";
import { RuntimeDefaultFields } from "../../components/ui/runtime-default-fields";

/** Device-only defaults; the catalog and controls are shared with connections. */
export function DeviceAccountDefaults({
  device,
  profile,
  onRefresh,
}: {
  device: DeviceProjection;
  profile: AgentProfileProjection;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation(["profiles", "common"]);
  const [draft, setDraft] = useState<CreateAgentProfileInput>({
    id: profile.id,
    deviceId: device.id,
    configScope: "device",
    connectionType: "local_login",
    runtime: profile.runtime,
    label: profile.label,
    model: profile.model ?? "",
    claudeEffort: profile.claudeEffort,
    claudePermissionMode: profile.claudePermissionMode,
    codexReasoningEffort: profile.codexReasoningEffort,
    codexSandboxMode: profile.codexSandboxMode,
    codexApprovalPolicy: profile.codexApprovalPolicy,
    codexSpeed: profile.codexSpeed,
    promptPrefix: profile.promptPrefix,
  });
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    if (loading || device.status !== "connected") return;
    setLoading(true);
    setNote("");
    try {
      const result = await listAgentModels(draft);
      setModels(result.map((row) => row.id));
      setNote(
        profile.runtime === "codex"
          ? t("accountDefaults.codexCatalog")
          : t("accountDefaults.claudeCatalog"),
      );
    } catch (cause) {
      setNote(
        cause instanceof Error
          ? cause.message
          : t("accountDefaults.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const invalidModel =
    !!draft.model && models.length > 0 && !models.includes(draft.model);
  return (
    <section
      className="fdy-device-account-defaults"
      aria-label={t("accountDefaults.sectionLabel", {
        runtime: profile.runtime,
      })}
    >
      <p className="fdy-account-form-hint">
        {t("accountDefaults.hint", { device: device.label })}
      </p>
      <div className="fdy-profile-field">
        <span>{t("accountDefaults.defaultModel")}</span>
        <ModelCombobox
          ariaLabel={t("accountDefaults.modelLabel", {
            runtime: profile.runtime,
          })}
          allowCustom={false}
          disabled={device.status !== "connected"}
          value={draft.model ?? ""}
          options={models}
          busy={loading}
          placeholder={t("accountDefaults.nativeDefault")}
          onRefresh={() => void load()}
          note={note}
          onChange={({ value }) => setDraft({ ...draft, model: value })}
        />
        <small>{loading ? t("accountDefaults.loading") : note}</small>
        {invalidModel ? (
          <small role="status">{t("accountDefaults.invalidModel")}</small>
        ) : null}
        {draft.model ? (
          <Button
            size="sm"
            variant="ghost"
            className="fdy-account-inline-action"
            onClick={() => setDraft({ ...draft, model: "" })}
          >
            {t("accountDefaults.useNativeDefault")}
          </Button>
        ) : null}
      </div>
      <RuntimeDefaultFields
        runtime={profile.runtime}
        value={draft}
        inherit
        onChange={(patch) => setDraft({ ...draft, ...patch })}
      />
      <div className="fdy-account-form-actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={
            busy ||
            invalidModel ||
            loading ||
            (!!draft.model && !models.includes(draft.model)) ||
            device.status !== "connected"
          }
          onClick={async () => {
            setBusy(true);
            setMessage("");
            try {
              await createAgentProfile(draft);
              await onRefresh();
              setMessage(t("accountDefaults.saved"));
            } catch (cause) {
              setMessage(
                cause instanceof Error
                  ? cause.message
                  : t("accountDefaults.saveFailed"),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("common:actions.saving") : t("accountDefaults.save")}
        </Button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </section>
  );
}
