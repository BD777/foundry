import { KeyRound, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProfileDefinition } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { TextInput } from "../../components/ui/field";
import { ModelCombobox } from "../../components/ui/model-combobox";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { RuntimeDefaultFields } from "../../components/ui/runtime-default-fields";
import {
  runtimeOptions,
  type ProfileDraft,
  type ProfileRuntime,
} from "./profile-draft";

export interface ProfileEditorProps {
  busy: boolean;
  draft: ProfileDraft;
  isNew: boolean;
  /** True only while the model catalog is being fetched. */
  modelsBusy: boolean;
  /** Why the last catalog read came back empty, if it did. */
  modelsNote: string;
  onChange: (patch: Partial<ProfileDraft>) => void;
  onClearCredential: () => void;
  onDelete: () => void;
  onLoadModels?: () => void;
  onRuntimeChange: (runtime: ProfileRuntime) => void;
  onSave: () => void;
  profile?: ProfileDefinition;
}

export function ProfileEditor({
  busy,
  draft,
  isNew,
  modelsBusy,
  modelsNote,
  onChange,
  onClearCredential,
  onDelete,
  onLoadModels,
  onRuntimeChange,
  onSave,
  profile,
}: ProfileEditorProps) {
  const { t } = useTranslation("profiles");
  const isClaude = draft.runtime === "claude";
  const hasCredential = profile?.hasCredential ?? false;
  // Refresh works wherever something can answer: the Codex CLI for its own
  // login, and any configured endpoint for its `/models` catalog. Only a Claude
  // login has neither.
  const canDiscoverModels = !!onLoadModels && draft.baseUrl.trim() !== "";

  // An unsaved profile has nothing to report yet; a saved one reports how
  // usable it is, from the same resolver the Device page and the list use.
  // A sealed key is optional, so a profile without one is stated, never warned.
  const statusBadge = isNew
    ? { label: t("editor.unsaved"), tone: "slate" as const }
    : profile && !profile.hasCredential
      ? { label: t("editor.noKey"), tone: "slate" as const }
      : undefined;

  return (
    <div className="fdy-profile-editor">
      <div className="fdy-profile-editor-header">
        <RuntimeMark runtime={draft.runtime} size="lg" />
        <span className="fdy-profile-editor-copy">
          <strong>{draft.label.trim() || t("editor.newConnection")}</strong>
          <em>{t("editor.kind")}</em>
          {profile ? (
            <small>
              {t("editor.updated", { time: profile.updatedAtLabel })}
            </small>
          ) : null}
        </span>
        {statusBadge ? (
          <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
        ) : null}
      </div>

      <div className="fdy-profile-editor-grid">
        <label className="fdy-profile-field">
          <span>{t("editor.name")}</span>
          <TextInput
            aria-label={t("editor.nameLabel")}
            onChange={(event) => onChange({ label: event.currentTarget.value })}
            placeholder={t("editor.namePlaceholder")}
            tone="boxed"
            value={draft.label}
          />
        </label>

        <label className="fdy-profile-field">
          <span>{t("editor.runtime")}</span>
          <SegmentedControl
            aria-label={t("editor.runtimeLabel")}
            onValueChange={onRuntimeChange}
            options={runtimeOptions}
            size="sm"
            value={draft.runtime}
          />
        </label>

        <>
          <label className="fdy-profile-field">
            <span>{t("editor.baseUrl")}</span>
            <TextInput
              aria-label={t("editor.baseUrlLabel")}
              onChange={(event) =>
                onChange({ baseUrl: event.currentTarget.value })
              }
              placeholder={
                isClaude
                  ? "https://gateway.example.com"
                  : "https://gateway.example.com/v1"
              }
              tone="boxed"
              value={draft.baseUrl}
            />
            <small>
              {t("editor.protocolHint", {
                // i18n-ignore: runtime product names
                runtime: isClaude ? "Claude" : "Codex",
              })}
            </small>
          </label>

          <div className="fdy-profile-field fdy-profile-credential">
            <span>{t("editor.apiKey")}</span>
            <TextInput
              aria-label={t("editor.apiKeyLabel")}
              autoComplete="off"
              onChange={(event) =>
                onChange({ apiKey: event.currentTarget.value })
              }
              placeholder={
                hasCredential
                  ? t("editor.apiKeySealed")
                  : t("editor.apiKeyKeyless")
              }
              tone="boxed"
              type="password"
              value={draft.apiKey}
            />
            <small>{t("editor.apiKeyHint")}</small>
            {hasCredential ? (
              <ConfirmButton
                confirmLabel={t("editor.clearConfirm")}
                disabled={busy}
                onConfirm={onClearCredential}
                size="sm"
                variant="ghost"
              >
                <KeyRound size={14} />
                {t("editor.clearCredential")}
              </ConfirmButton>
            ) : null}
          </div>
        </>

        <div className="fdy-profile-field fdy-profile-field-wide">
          <span>{t("editor.model")}</span>
          <ModelCombobox
            ariaLabel={t("editor.modelLabel")}
            busy={modelsBusy}
            note={
              modelsNote ||
              (canDiscoverModels
                ? t("editor.modelRefreshNote")
                : t("editor.modelTypeNote"))
            }
            onChange={({ options, value }) =>
              onChange({ model: value, models: options })
            }
            onRefresh={canDiscoverModels ? onLoadModels : undefined}
            options={draft.models}
            placeholder={isClaude ? "claude-sonnet-4-5" : "gpt-6-astra"}
            value={draft.model}
          />
          <small>{t("editor.modelHint")}</small>
        </div>
      </div>

      <details className="fdy-profile-defaults">
        <summary>{t("editor.runtimeDefaults")}</summary>
        <RuntimeDefaultFields
          runtime={draft.runtime}
          value={draft}
          onChange={onChange}
          insideDialog
        />
      </details>

      <div className="fdy-profile-editor-actions">
        <span>{t("editor.saveThenAssign")}</span>
        {profile ? (
          <ConfirmButton
            confirmLabel={t("editor.deleteConfirm")}
            disabled={busy}
            onConfirm={onDelete}
            size="sm"
            variant="ghost"
          >
            <Trash2 size={14} />
            {t("editor.delete")}
          </ConfirmButton>
        ) : null}
        <Button
          disabled={busy || !draft.label.trim() || !draft.baseUrl.trim()}
          onClick={onSave}
          size="sm"
          variant="primary"
        >
          <Save size={14} />
          {isNew ? t("editor.create") : t("editor.save")}
        </Button>
      </div>
    </div>
  );
}
