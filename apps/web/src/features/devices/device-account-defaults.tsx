import { useEffect, useState } from "react";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@foundry/protocol";
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
          ? "Official catalog from Codex. The native CLI may use its built-in fallback; account availability can differ."
          : "Official options reported by Claude Code on this device.",
      );
    } catch (cause) {
      setNote(
        cause instanceof Error
          ? cause.message
          : "Could not load official models. Retry.",
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
      aria-label={`${profile.runtime} runtime defaults`}
    >
      <p className="fdy-account-form-hint">
        Defaults for new sessions on {device.label}. Existing sessions are
        unchanged.
      </p>
      <div className="fdy-profile-field">
        <span>Default model</span>
        <ModelCombobox
          ariaLabel={`${profile.runtime} official default model`}
          allowCustom={false}
          disabled={device.status !== "connected"}
          value={draft.model ?? ""}
          options={models}
          busy={loading}
          placeholder="Native agent default"
          onRefresh={() => void load()}
          note={note}
          onChange={({ value }) => setDraft({ ...draft, model: value })}
        />
        <small>{loading ? "Loading official models…" : note}</small>
        {invalidModel ? (
          <small role="status">
            The saved model is not in this official catalog. Select an official
            model or use the native default.
          </small>
        ) : null}
        {draft.model ? (
          <Button
            size="sm"
            variant="ghost"
            className="fdy-account-inline-action"
            onClick={() => setDraft({ ...draft, model: "" })}
          >
            Use native default
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
              setMessage("Device defaults saved.");
            } catch (cause) {
              setMessage(
                cause instanceof Error
                  ? cause.message
                  : "Could not save defaults.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save defaults"}
        </Button>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </section>
  );
}
