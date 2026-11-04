import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccessLevel,
  ExternalAccount,
  ExternalAccountBinding,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import { setWorkspaceAccountAccess } from "../../api";
import { Alert } from "../../components/ui/alert";
import { FieldHint, Radio } from "../../components/ui/field";
import type { ToastTone } from "../../components/ui/toast";
import { errorText } from "./account-format";
import { CheckLabel } from "../../components/ui/check-label";

/** The default when the server names no levels. */
const readOnly: ExternalAccessLevel[] = [{ name: "read" }];

export function missingAccessScopes(
  level: ExternalAccessLevel,
  granted: readonly string[] | undefined,
): string[] {
  return (level.scopes ?? []).filter((s) => !(granted ?? []).includes(s));
}

/**
 * What a workspace's sessions may do in its bound zones (DEV-092): one
 * native radio per level, applied when chosen. A level whose scopes the
 * authorization lacks cannot be chosen and says how to get them.
 */
export function CloudflareAccessLevels({
  workspaceId,
  binding,
  account,
  levels,
  disabled,
  onChanged,
  onNotice,
}: {
  workspaceId: string;
  binding: ExternalAccountBinding;
  account: ExternalAccount;
  levels?: ExternalAccessLevel[];
  disabled: boolean;
  onChanged: (v: WorkspaceExternalAccounts) => void;
  onNotice: (s: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const name = useId();
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const options = levels?.length ? levels : readOnly;
  const current = binding.access || options[0]!.name;
  const label = (level: string) =>
    level === "read"
      ? t("cloudflare.accessRead")
      : level === "dns_edit"
        ? t("cloudflare.accessDnsEdit")
        : level;
  const detail = (level: string) =>
    level === "read"
      ? t("cloudflare.accessReadDetail")
      : level === "dns_edit"
        ? t("cloudflare.accessDnsEditDetail")
        : "";
  const currentLevel = options.find((l) => l.name === current);
  const lost = currentLevel
    ? missingAccessScopes(currentLevel, account.grantedScopes)
    : [];
  async function choose(level: string) {
    // The radios stay enabled while saving so keyboard focus stays put.
    if (level === current || saving) return;
    setSaving(level);
    setError("");
    try {
      onChanged(
        await setWorkspaceAccountAccess(workspaceId, account.id, level),
      );
      onNotice(t("cloudflare.accessSaved", { level: label(level) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving("");
    }
  }
  return (
    <fieldset
      className="grid min-w-0 gap-2"
      aria-busy={saving ? true : undefined}
    >
      <legend className="mb-0.5 text-sm font-semibold">
        {t("cloudflare.accessTitle")}
      </legend>
      <FieldHint>{t("cloudflare.accessDetail")}</FieldHint>
      {options.map((level) => {
        const missing = missingAccessScopes(level, account.grantedScopes);
        const blocked = missing.length > 0 && level.name !== current;
        const hintId = `${name}-${level.name}`;
        return (
          <CheckLabel
            key={level.name}
            className="data-disabled:cursor-default data-disabled:[&_strong]:text-ink-muted [&>span]:wrap-anywhere"
            data-disabled={blocked || disabled ? true : undefined}
          >
            <Radio
              name={name}
              value={level.name}
              checked={(saving || current) === level.name}
              disabled={disabled || blocked}
              aria-describedby={hintId}
              onChange={() => void choose(level.name)}
            />
            <span id={hintId}>
              <strong>{label(level.name)}</strong>
              <small>{detail(level.name)}</small>
              {blocked ? (
                <span className="text-xs text-ink">
                  {t("cloudflare.accessNeedsScopes", {
                    scopes: missing.join(", "),
                  })}
                </span>
              ) : null}
            </span>
          </CheckLabel>
        );
      })}
      {lost.length ? (
        <Alert
          tone="warning"
          title={t("cloudflare.accessGrantLost", {
            level: label(current),
            scopes: lost.join(", "),
          })}
        />
      ) : null}
      {error ? <Alert tone="error" title={error} /> : null}
    </fieldset>
  );
}
