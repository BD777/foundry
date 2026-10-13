import type { ExternalProviderApp } from "@bd777/foundry-protocol";
import { i18n } from "../i18n";

/** The end of a Feishu app ID: enough to tell two apps apart. */
export function shortAppId(clientId: string): string {
  return clientId.replace(/^cli_/, "").slice(-6);
}

/**
 * What a person calls a Feishu app: the name given to it here, else
 * Feishu's own name for it, else "Feishu app" and the end of its ID. The
 * server's default label ("Feishu app cli_…") counts as no name.
 */
export function feishuAppName(app: ExternalProviderApp): string {
  const label = app.label.trim();
  if (label && !label.endsWith(app.clientId)) return label;
  if (app.appName) return app.appName;
  return i18n.t("externalAccounts:apps.defaultName", {
    id: shortAppId(app.clientId),
  });
}

/**
 * What to call an app's or account's organisation: Feishu's name for it
 * when the app may read it, else the domain of the person's enterprise
 * email, else nothing.
 */
export function organisationLabel(named: {
  tenantName?: string;
  orgDomain?: string;
}): string {
  return named.tenantName || named.orgDomain || "";
}

/**
 * An app as a picker lists it: its name, its organisation and the reader's
 * accounts connected through it ("Foundry Agent · Acme · Ada"), never the
 * raw app ID.
 */
export function feishuAppSummary(app: ExternalProviderApp): string {
  return [
    feishuAppName(app),
    organisationLabel(app),
    ...(app.accountNames ?? []),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Feishu's code for an app lacking an app-identity (tenant token) scope. */
const missingAppScopeCode = "99991672";

/**
 * The scope the app lacks to read its organisation's name, and the Feishu /
 * Lark console page that enables it, when that is why the name is missing.
 * Optional: the organisation is labelled by its email domain meanwhile.
 * The scope comes from Feishu's refusal ("… required: [tenant:tenant:readonly]").
 */
export function tenantNameScopeHint(
  app: ExternalProviderApp,
): { scope: string; url: string } | undefined {
  if (app.tenantName || !app.namesDetail) return undefined;
  const refusal = app.namesDetail
    .split("; ")
    .find((part) =>
      part.startsWith(`tenant name: code ${missingAppScopeCode}`),
    );
  if (!refusal) return undefined;
  const scope = /\[([\w.:-]+)/.exec(refusal)?.[1] ?? "tenant:tenant:readonly";
  const base = (app.baseUrl || "https://open.feishu.cn").replace(/\/$/, "");
  // The scope's characters ([\w.:-]) need no escaping in a query.
  return {
    scope,
    url: `${base}/app/${encodeURIComponent(app.clientId)}/auth?q=${scope}&op_from=openapi&token_type=tenant`,
  };
}
