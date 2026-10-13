import type {
  ExternalAccount,
  ExternalAccountStatus,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";
import { feishuAppName, organisationLabel } from "../../lib/feishu-app-names";

/** What a person calls the account: their label, else who it is. */
export function accountName(account: ExternalAccount): string {
  return account.label || account.displayName || account.subject || account.id;
}

/** What a person calls an app: its name here, else Feishu's, else a short ID. */
export function appName(app: ExternalProviderApp): string {
  return feishuAppName(app);
}

/** Who the account is: the person's name at the provider, else its label. */
export function personName(account: ExternalAccount): string {
  return account.displayName || accountName(account);
}

/** The name the person gave the account, when it is not their own name. */
export function customLabel(account: ExternalAccount): string {
  return account.label && account.label !== personName(account)
    ? account.label
    : "";
}

/** Where an account lives: its organisation, then its app ("Acme · Foundry Agent"). */
export function accountPlace(
  account: ExternalAccount,
  app: ExternalProviderApp | undefined,
): string {
  return [
    organisationLabel(app ?? {}) || organisationLabel(account),
    app ? appName(app) : account.appName,
  ]
    .filter(Boolean)
    .join(" · ");
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

export { relativeWhen } from "../../lib/relative-time";

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
