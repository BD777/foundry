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
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { SectionHeader } from "../../components/ui/page-header";
import { ModelCombobox } from "../../components/agent-runtime/model-combobox";
import { RuntimeDefaultFields } from "../../components/agent-runtime/runtime-default-fields";
import { LoadingState } from "../../components/ui/loading";
import { AccountField } from "./account-field";

/**
 * Device-only defaults of a login or a connector's launch environment; the
 * catalog and controls are shared with connections. `below` sets it under
 * its row instead of beside the account's details.
 */
export function DeviceAccountDefaults({
  device,
  profile,
  onRefresh,
  placement = "beside",
}: {
  device: DeviceProjection;
  profile: AgentProfileProjection;
  onRefresh: () => Promise<void>;
  placement?: "beside" | "below";
}) {
  const { t } = useTranslation(["profiles", "common"]);
  const [draft, setDraft] = useState<CreateAgentProfileInput>({
    id: profile.id,
    deviceId: device.id,
    configScope: "device",
    connectionType:
      profile.connectionType === "external" ? "external" : "local_login",
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
  // A connector's launch environment offers its own models, not an
  // official catalog, and its own default.
  const external = profile.connectionType === "external";
  const provider = { provider: profile.label };
  const invalidWindow = Object.values(windows).some(
    (value) => value.trim() && parseContextWindow(value) === undefined,
  );
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogHint, setCatalogHint] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">(
    "success",
  );
  /** `refresh` asks the device again rather than reuse this page's read. */
  async function load(refresh = false) {
    if (loading || device.status !== "connected") return;
    setLoading(true);
    setCatalogHint("");
    setLoadError("");
    try {
      const result = await listAgentModels(draft, { reuse: !refresh });
      setModels(result.map((row) => row.id));
      setCatalogHint(
        external
          ? t("accountDefaults.external.catalog", provider)
          : profile.runtime === "codex"
            ? t("accountDefaults.codexCatalog")
            : t("accountDefaults.claudeCatalog"),
      );
    } catch (cause) {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : external
            ? t("accountDefaults.external.loadFailed", provider)
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
      className={
        placement === "below"
          ? "grid min-w-0 content-start gap-5 border-t border-line pt-5 [&>p]:leading-[1.6]"
          : "grid min-w-0 content-start gap-5 border-l border-line pl-7 [&>p]:leading-[1.6] max-[1000px]:border-t max-[1000px]:border-l-0 max-[1000px]:pt-6 max-[1000px]:pl-0"
      }
      aria-label={t("accountDefaults.sectionLabel", {
        runtime: profile.runtime,
      })}
    >
      <SectionHeader
        level={3}
        title={t("accountDefaults.title", { device: device.label })}
        description={t("accountDefaults.hint")}
      />
      <AccountField>
        <span>{t("accountDefaults.defaultModel")}</span>
        <ModelCombobox
          ariaLabel={
            external
              ? t("accountDefaults.external.modelLabel", provider)
              : t("accountDefaults.modelLabel", { runtime: profile.runtime })
          }
          allowCustom={false}
          disabled={device.status !== "connected"}
          value={draft.model ?? ""}
          options={models}
          busy={loading}
          placeholder={
            external
              ? t("accountDefaults.external.providerDefault", provider)
              : t("accountDefaults.nativeDefault")
          }
          onRefresh={() => void load(true)}
          hint={catalogHint}
          onChange={({ value }) => setDraft({ ...draft, model: value })}
        />
        {loading ? (
          <LoadingState
            label={
              external
                ? t("accountDefaults.external.loading", provider)
                : t("accountDefaults.loading")
            }
          />
        ) : loadError ? (
          <Alert tone="error" size="compact" title={loadError} />
        ) : catalogHint ? (
          <FieldHint as="small">{catalogHint}</FieldHint>
        ) : null}
        {invalidModel ? (
          <Alert
            role="status"
            tone="warning"
            size="compact"
            title={
              external
                ? t("accountDefaults.external.invalidModel", provider)
                : t("accountDefaults.invalidModel")
            }
          />
        ) : null}
        {draft.model ? (
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => setDraft({ ...draft, model: "" })}
          >
            {external
              ? t("accountDefaults.external.useProviderDefault", provider)
              : t("accountDefaults.useNativeDefault")}
          </Button>
        ) : null}
      </AccountField>
      {profile.runtime === "codex" ? (
        <AccountField>
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
        </AccountField>
      ) : null}
      <RuntimeDefaultFields
        runtime={profile.runtime}
        value={draft}
        inherit
        onChange={(patch) => setDraft({ ...draft, ...patch })}
      />
      <div className="flex flex-wrap items-center gap-2.5 text-xs">
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
