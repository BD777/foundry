import type {
  ExternalAccount,
  ExternalAccountStatus,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";

/** What a person calls the account: their label, else who it is. */
export function accountName(account: ExternalAccount): string {
  return account.label || account.displayName || account.subject || account.id;
}

/** A provider's name in the interface ("feishu" → "Feishu"). */
export function providerLabel(kind: string): string {
  return kind === "feishu" ? i18n.t("externalAccounts:providers.feishu") : kind;
}

/** Sessions get a token only from a ready or expiring account. */
export function accountUsable(account: ExternalAccount): boolean {
  return account.status === "ready" || account.status === "expiring";
}

export function statusTone(
  status: ExternalAccountStatus,
): NonNullable<BadgeProps["tone"]> {
  switch (status) {
    case "ready":
      return "online";
    case "expiring":
      return "brass";
    case "needs_reauth":
      return "warn";
    case "revoked":
      return "slate";
  }
}

export function statusLabel(status: ExternalAccountStatus): string {
  return i18n.t(`externalAccounts:status.${status}`);
}

/** Why an unusable account stopped working, in words. */
export function statusDetailText(account: ExternalAccount): string {
  if (accountUsable(account)) return "";
  if (account.status === "revoked")
    return i18n.t("externalAccounts:statusDetail.revoked");
  switch (account.statusDetail) {
    case "refresh_token_expired":
    case "authorization_expired":
      return i18n.t(`externalAccounts:statusDetail.${account.statusDetail}`);
    default:
      return i18n.t("externalAccounts:statusDetail.other", {
        detail: account.statusDetail || account.status,
      });
  }
}

const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "in 6 days": a timestamp relative to now. */
export function relativeWhen(
  iso: string | undefined,
  now = Date.now(),
): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const delta = at - now;
  const format = new Intl.RelativeTimeFormat(i18n.language, {
    numeric: "auto",
  });
  for (const [unit, size] of relativeUnits)
    if (Math.abs(delta) >= size)
      return format.format(Math.round(delta / size), unit);
  return format.format(0, "minute");
}

/** m:ss left until an expiry. */
export function countdown(iso: string | undefined, now = Date.now()): string {
  const left = Math.max(
    0,
    Math.floor(((iso ? Date.parse(iso) : now) - now) / 1000),
  );
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
