import { ToastFeedback } from "../../components/ui/toast";
import {
  officialContextWindow,
  parseContextWindow,
} from "@bd777/foundry-protocol";
import { FieldHint, TextInput } from "../../components/ui/field";
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
    contextWindows: profile.contextWindows,
    promptPrefix: profile.promptPrefix,
  });
  const [windows, setWindows] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(profile.contextWindows ?? {}).map(([model, tokens]) => [
        model,
        String(tokens),
      ]),
    ),
  );
  const invalidWindow = Object.values(windows).some(
    (value) => value.trim() && parseContextWindow(value) === undefined,
  );
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">(
    "success",
  );
  /** `refresh` asks the device again rather than reuse this page's read. */
  async function load(refresh = false) {
    if (loading || device.status !== "connected") return;
    setLoading(true);
    setNote("");
    try {
      const result = await listAgentModels(draft, { reuse: !refresh });
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
      <FieldHint>
        {t("accountDefaults.hint", { device: device.label })}
      </FieldHint>
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
          onRefresh={() => void load(true)}
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
      {profile.runtime === "codex" ? (
        <div className="fdy-profile-field">
          <label htmlFor={`context-window-${profile.id}`}>
            {t("accountDefaults.contextWindow")}
          </label>
          <TextInput
            id={`context-window-${profile.id}`}
            tone="boxed"
            value={windows[draft.model ?? ""] ?? ""}
            disabled={!draft.model || busy || device.status !== "connected"}
            aria-invalid={invalidWindow || undefined}
            placeholder={t("accountDefaults.contextAutomatic")}
            onChange={(event) =>
              setWindows({
                ...windows,
                [draft.model!]: event.currentTarget.value,
              })
            }
          />
          <FieldHint as="small">
            {!draft.model
              ? t("accountDefaults.contextChooseModel")
              : t("accountDefaults.contextHint", {
                  limit:
                    officialContextWindow(draft.model)?.toLocaleString() ??
                    t("accountDefaults.contextNativeLimit"),
                })}
          </FieldHint>
          {invalidWindow ? (
            <FieldHint as="small" tone="error" role="alert">
              {t("contextWindows.invalid")}
            </FieldHint>
          ) : null}
        </div>
      ) : null}
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
            invalidWindow ||
            loading ||
            (!!draft.model && !models.includes(draft.model)) ||
            device.status !== "connected"
          }
          onClick={async () => {
            setBusy(true);
            setMessage("");
            setMessageTone("success");
            try {
              await createAgentProfile({
                ...draft,
                contextWindows: Object.fromEntries(
                  Object.entries(windows).flatMap(([model, value]) => {
                    const tokens = parseContextWindow(value);
                    return tokens === undefined ? [] : [[model, tokens]];
                  }),
                ),
              });
              await onRefresh();
              setMessage(t("accountDefaults.saved"));
            } catch (cause) {
              setMessageTone("error");
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
        {message ? <ToastFeedback tone={messageTone} title={message} /> : null}
      </div>
    </section>
  );
}
