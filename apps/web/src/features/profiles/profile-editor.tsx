import { KeyRound, Save, Trash2 } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import {
  normalizeProviderBaseUrl,
  type ProfileDefinition,
} from "@bd777/foundry-protocol";
import { cn } from "../../lib/cn";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { profileFieldClass } from "../../components/agent-runtime/profile-field";
import { ModelCombobox } from "../../components/agent-runtime/model-combobox";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { RuntimeDefaultFields } from "../../components/agent-runtime/runtime-default-fields";
import { ContextWindowFields } from "./context-window-fields";
import { ModelPriceFields } from "./model-price-fields";
import { codexTransportOptions, codexTransportStatus } from "./codex-transport";
import {
  invalidContextWindows,
  invalidModelPrices,
  runtimeOptions,
  type ProfileDraft,
  type ProfileRuntime,
} from "./profile-draft";

const defaultsClass =
  "border-y border-line-soft py-3 open:[&>summary]:mb-3.5 [&+details]:border-t-0";
const summaryClass = "cursor-pointer text-xs font-semibold text-ink-muted";

/** A caption (`<span>`) above its control, hint and status lines. */
function ProfileField({
  as: Component = "label",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "label" | "div" }) {
  return (
    <Component
      className={cn("fdy-profile-field", profileFieldClass, className)}
      {...props}
    />
  );
}

export interface ProfileEditorProps {
  busy: boolean;
  /** Windows the endpoint's catalog reported, by model; undefined until read. */
  catalogWindows?: Record<string, number>;
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
  /** Reads the catalog's windows only; absent when no device can ask. */
  onReadCatalogWindows?: () => void;
  onRuntimeChange: (runtime: ProfileRuntime) => void;
  onSave: () => void;
  profile?: ProfileDefinition;
}

export function ProfileEditor({
  busy,
  catalogWindows,
  draft,
  isNew,
  modelsBusy,
  modelsNote,
  onChange,
  onClearCredential,
  onDelete,
  onLoadModels,
  onReadCatalogWindows,
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
  const canReadWindows =
    !!onReadCatalogWindows && draft.baseUrl.trim() !== ""
      ? onReadCatalogWindows
      : undefined;
  const windowsInvalid = invalidContextWindows(draft).length > 0;
  const pricesInvalid = invalidModelPrices(draft).length > 0;
  // What the server will save, by the same rules: a URL in the other
  // runtime's form or with a request path is corrected, an unusable one is
  // refused before Save.
  const endpoint = draft.baseUrl.trim()
    ? normalizeProviderBaseUrl(draft.runtime, draft.baseUrl)
    : undefined;
  const endpointError =
    endpoint && "error" in endpoint ? endpoint.error : undefined;
  const endpointFix =
    endpoint && "baseUrl" in endpoint && endpoint.corrections.length > 0
      ? endpoint
      : undefined;

  // An unsaved profile has nothing to report yet; a saved one reports how
  // usable it is, from the same resolver the Device page and the list use.
  // A sealed key is optional, so a profile without one is stated, never warned.
  const statusBadge = isNew
    ? { label: t("editor.unsaved"), tone: "slate" as const }
    : profile && !profile.hasCredential
      ? { label: t("editor.noKey"), tone: "slate" as const }
      : undefined;

  return (
    <div className="fdy-profile-editor grid min-w-0 gap-4.5">
      <div className="flex items-center gap-3">
        <RuntimeMark runtime={draft.runtime} size="lg" />
        <span className="grid min-w-0 flex-1 gap-0.75 [&>em]:truncate [&>em]:text-2xs [&>em]:text-ink-muted [&>em]:not-italic [&>small]:truncate [&>small]:text-2xs [&>small]:text-ink-faint [&>strong]:text-md [&>strong]:font-bold [&>strong]:text-ink">
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

      <div className="grid min-w-0 grid-cols-2 gap-3.5 max-[680px]:grid-cols-1">
        <ProfileField>
          <span>{t("editor.name")}</span>
          <TextInput
            aria-label={t("editor.nameLabel")}
            onChange={(event) => onChange({ label: event.currentTarget.value })}
            placeholder={t("editor.namePlaceholder")}
            tone="boxed"
            value={draft.label}
          />
        </ProfileField>

        <ProfileField>
          <span>{t("editor.runtime")}</span>
          <SegmentedControl
            aria-label={t("editor.runtimeLabel")}
            fill
            onValueChange={onRuntimeChange}
            options={runtimeOptions}
            size="sm"
            value={draft.runtime}
          />
        </ProfileField>

        <>
          <ProfileField>
            <span>{t("editor.baseUrl")}</span>
            <TextInput
              aria-invalid={endpointError ? true : undefined}
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
            {endpointError ? (
              <FieldHint as="small" tone="error" role="alert">
                {t(`editor.baseUrlError.${endpointError}`)}
              </FieldHint>
            ) : null}
            {endpointFix ? (
              <FieldHint as="small" role="status" tone="info">
                {t("editor.baseUrlSavedAs", { url: endpointFix.baseUrl })}{" "}
                {endpointFix.corrections
                  .map((correction) =>
                    t(`editor.baseUrlCorrection.${correction}`),
                  )
                  .join(" ")}
              </FieldHint>
            ) : null}
            <FieldHint as="small">
              {t("editor.protocolHint", {
                // i18n-ignore: runtime product names
                runtime: isClaude ? "Claude" : "Codex",
              })}
            </FieldHint>
          </ProfileField>

          <ProfileField
            as="div"
            className="col-span-full grid-cols-[minmax(0,1fr)_auto] max-[680px]:grid-cols-[minmax(0,1fr)] [&>span]:col-span-full"
          >
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
            <FieldHint as="small" className="col-span-full">
              {t("editor.apiKeyHint")}
            </FieldHint>
          </ProfileField>
        </>

        {draft.runtime === "codex" && draft.authMode === "custom" ? (
          <ProfileField as="div" className="col-span-full">
            <span>{t("codexTransport.title")}</span>
            <SegmentedControl
              aria-label={t("codexTransport.label")}
              fill
              onValueChange={(codexTransport) => onChange({ codexTransport })}
              options={codexTransportOptions(t)}
              size="sm"
              value={draft.codexTransport}
            />
            <FieldHint as="small" role="status" tone="info">
              {codexTransportStatus(
                t,
                draft.codexTransport,
                profile?.codexTransportLearned,
              )}
            </FieldHint>
            <FieldHint as="small">{t("codexTransport.hint")}</FieldHint>
          </ProfileField>
        ) : null}

        <ProfileField as="div" className="col-span-full">
          <span>{t("editor.model")}</span>
          <ModelCombobox
            ariaLabel={t("editor.modelLabel")}
            busy={modelsBusy}
            hint={
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
          <FieldHint as="small">{t("editor.modelHint")}</FieldHint>
        </ProfileField>
      </div>

      <details className={defaultsClass}>
        <summary className={summaryClass}>{t("modelPrices.title")}</summary>
        <ModelPriceFields
          busy={busy}
          draft={draft}
          onChange={(modelPrices) => onChange({ modelPrices })}
        />
      </details>

      <details
        className={defaultsClass}
        onToggle={(event) => {
          // Opening the section reads the windows the endpoint reports.
          if (event.currentTarget.open && catalogWindows === undefined)
            canReadWindows?.();
        }}
      >
        <summary className={summaryClass}>{t("contextWindows.title")}</summary>
        <ContextWindowFields
          busy={busy || modelsBusy}
          catalogWindows={catalogWindows}
          models={draft.models}
          onChange={(contextWindows) => onChange({ contextWindows })}
          onReadCatalog={canReadWindows}
          values={draft.contextWindows}
        />
      </details>

      <details className={defaultsClass}>
        <summary className={summaryClass}>
          {t("editor.runtimeDefaults")}
        </summary>
        <RuntimeDefaultFields
          runtime={draft.runtime}
          value={draft}
          onChange={onChange}
          insideDialog
        />
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <FieldHint as="span" className="mt-0 min-w-60 flex-1">
          {t("editor.saveThenAssign")}
        </FieldHint>
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
          disabled={
            busy ||
            windowsInvalid ||
            pricesInvalid ||
            !!endpointError ||
            !draft.label.trim() ||
            !draft.baseUrl.trim()
          }
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
