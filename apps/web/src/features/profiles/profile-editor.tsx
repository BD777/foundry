import { KeyRound, Save, Trash2 } from "lucide-react";
import type { ProfileDefinition } from "@foundry/protocol";
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
    ? { label: "Unsaved", tone: "slate" as const }
    : profile && !profile.hasCredential
      ? { label: "No key configured", tone: "slate" as const }
      : undefined;

  return (
    <div className="fdy-profile-editor">
      <div className="fdy-profile-editor-header">
        <RuntimeMark runtime={draft.runtime} size="lg" />
        <span className="fdy-profile-editor-copy">
          <strong>{draft.label.trim() || "New connection"}</strong>
          <em>API / gateway connection</em>
          {profile ? <small>Updated {profile.updatedAtLabel}</small> : null}
        </span>
        {statusBadge ? (
          <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
        ) : null}
      </div>

      <div className="fdy-profile-editor-grid">
        <label className="fdy-profile-field">
          <span>Name</span>
          <TextInput
            aria-label="Profile name"
            onChange={(event) => onChange({ label: event.currentTarget.value })}
            placeholder="My model connection"
            tone="boxed"
            value={draft.label}
          />
        </label>

        <label className="fdy-profile-field">
          <span>Runtime</span>
          <SegmentedControl
            aria-label="Profile runtime"
            onValueChange={onRuntimeChange}
            options={runtimeOptions}
            size="sm"
            value={draft.runtime}
          />
        </label>

        <>
          <label className="fdy-profile-field">
            <span>Base URL</span>
            <TextInput
              aria-label="Profile base URL"
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
              {isClaude ? "Claude" : "Codex"} protocol is selected from the
              runtime. Provider type does not need separate configuration.
            </small>
          </label>

          <div className="fdy-profile-field fdy-profile-credential">
            <span>API key · Optional</span>
            <TextInput
              aria-label="Profile API key"
              autoComplete="off"
              onChange={(event) =>
                onChange({ apiKey: event.currentTarget.value })
              }
              placeholder={
                hasCredential
                  ? "Sealed on this server — leave blank to keep it"
                  : "Leave blank for a keyless gateway"
              }
              tone="boxed"
              type="password"
              value={draft.apiKey}
            />
            <small>
              Optional. Leave it empty for internal gateways or proxies that
              authenticate themselves; nothing is sent without a key.
            </small>
            {hasCredential ? (
              <ConfirmButton
                confirmLabel="Clear it for good?"
                disabled={busy}
                onConfirm={onClearCredential}
                size="sm"
                variant="ghost"
              >
                <KeyRound size={14} />
                Clear credential
              </ConfirmButton>
            ) : null}
          </div>
        </>

        <div className="fdy-profile-field fdy-profile-field-wide">
          <span>Model</span>
          <ModelCombobox
            ariaLabel="Profile model"
            busy={modelsBusy}
            note={
              modelsNote ||
              (canDiscoverModels
                ? "Refresh asks this endpoint for its catalog. Anything you type is kept as an option."
                : "Type the model you want. Connect a device and enter an endpoint to refresh its catalog.")
            }
            onChange={({ options, value }) =>
              onChange({ model: value, models: options })
            }
            onRefresh={canDiscoverModels ? onLoadModels : undefined}
            options={draft.models}
            placeholder={isClaude ? "claude-sonnet-4-5" : "gpt-6-astra"}
            value={draft.model}
          />
          <small>
            Every model here is selectable in chat and issue runs; the checked
            one is the default.
          </small>
        </div>
      </div>

      <details className="fdy-profile-defaults">
        <summary>Runtime defaults</summary>
        <RuntimeDefaultFields
          runtime={draft.runtime}
          value={draft}
          onChange={onChange}
          insideDialog
        />
      </details>

      <div className="fdy-profile-editor-actions">
        <span>Save first, then assign devices below.</span>
        {profile ? (
          <ConfirmButton
            confirmLabel="Delete this connection?"
            disabled={busy}
            onConfirm={onDelete}
            size="sm"
            variant="ghost"
          >
            <Trash2 size={14} />
            Delete
          </ConfirmButton>
        ) : null}
        <Button
          disabled={busy || !draft.label.trim() || !draft.baseUrl.trim()}
          onClick={onSave}
          size="sm"
          variant="primary"
        >
          <Save size={14} />
          {isNew ? "Create connection" : "Save connection"}
        </Button>
      </div>
    </div>
  );
}
