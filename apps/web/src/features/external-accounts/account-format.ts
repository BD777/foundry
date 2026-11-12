import type {
  ExternalAccount,
  ExternalAccountStatus,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import type { BadgeProps } from "../../components/ui/badge";
import { i18n } from "../../i18n";
import { feishuAppName } from "../../lib/feishu-app-names";
export {
  accountName,
  accountPlace,
  customLabel,
  personName,
} from "../../lib/account-display";

/** What a person calls an app: its name here, else Feishu's, else a short ID. */
export function appName(app: ExternalProviderApp): string {
  return feishuAppName(app);
}

/** A provider's name in the interface ("feishu" → "Feishu"). */
export function providerLabel(kind: string): string {
  return kind === "feishu"
    ? i18n.t(`externalAccounts:providers.${kind}`)
    : kind;
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

export { errorText } from "../../lib/errors";
export { relativeWhen } from "../../lib/time-format";

/** m:ss left until an expiry. */
export function countdown(iso: string | undefined, now = Date.now()): string {
  const left = Math.max(
    0,
    Math.floor(((iso ? Date.parse(iso) : now) - now) / 1000),
  );
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
