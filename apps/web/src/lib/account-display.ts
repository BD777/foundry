import type { ExternalProviderApp } from "@bd777/foundry-protocol";
import { feishuAppName, organisationLabel } from "./feishu-app-names";

/** The fields shared by Connectors and Assistant settings account lists. */
export interface AccountDisplay {
  id: string;
  label: string;
  displayName?: string;
  subject?: string;
  appName?: string;
  tenantName?: string;
  orgDomain?: string;
}

/** What a person calls the account: their label, else who it is. */
export function accountName(account: AccountDisplay): string {
  return account.label || account.displayName || account.subject || account.id;
}

/** Who the account is: the person's name at the provider, else its label. */
export function personName(account: AccountDisplay): string {
  return account.displayName || accountName(account);
}

/** The name the person gave the account, when it is not their own name. */
export function customLabel(account: AccountDisplay): string {
  return account.label && account.label !== personName(account)
    ? account.label
    : "";
}

/** Where an account lives: its organisation, then its app ("Acme · Foundry Agent"). */
export function accountPlace(
  account: AccountDisplay,
  app?: ExternalProviderApp,
): string {
  return [
    organisationLabel(app ?? {}) || organisationLabel(account),
    app ? feishuAppName(app) : account.appName,
  ]
    .filter(Boolean)
    .join(" · ");
}
