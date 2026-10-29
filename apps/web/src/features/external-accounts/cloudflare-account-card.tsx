import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExternalAccount } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { TextInput } from "../../components/ui/field";
import { CloudflareActivity } from "./cloudflare-activity";
import {
  groupCloudflareScopes,
  summarizeCloudflareScopes,
} from "./cloudflare-scopes";

/** Past this many permissions the list gets a filter field. */
const filterThreshold = 30;

/**
 * One connected Cloudflare identity: who it is, what it may do in short,
 * what Foundry uses of it, and the full permission list on request
 * (DEV-091). A broad grant is the person's choice, not a warning.
 */
export function CloudflareAccountCard({
  account,
  requestedScopes,
  onReauthorize,
  onRevoke,
}: {
  account: ExternalAccount;
  /** What Foundry asks for; undefined while unknown. */
  requestedScopes?: string[];
  onReauthorize: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const filterId = useId();
  const [filter, setFilter] = useState("");
  const summary = summarizeCloudflareScopes(
    account.grantedScopes,
    requestedScopes,
  );
  const groups = groupCloudflareScopes(account.grantedScopes, filter);
  const verified = account.status === "ready" || account.status === "expiring";
  const revokePending = account.statusDetail === "provider_revoke_pending";
  return (
    <li className="fdy-xacc-row fdy-cf-account">
      <div className="fdy-cf-account-head">
        <strong className="fdy-cf-account-name">
          {account.displayName || account.label}
        </strong>
        <span className="fdy-xacc-form-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={revokePending}
            onClick={onReauthorize}
          >
            {t("cloudflare.reauthorize")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            {t("cloudflare.revoke")}
          </Button>
        </span>
      </div>
      <div className="fdy-cf-identity">
        <span>
          {verified
            ? t("cloudflare.identityVerified")
            : t("cloudflare.needsAuth")}
        </span>
        {account.subject ? (
          <span className="fdy-cf-subject">
            <code>{account.subject}</code>
            <CopyButton
              text={account.subject}
              label={t("cloudflare.copyUserId")}
              copiedLabel={t("cloudflare.copiedUserId")}
            />
          </span>
        ) : null}
      </div>
      {revokePending ? (
        <p className="fdy-xacc-muted">{t("cloudflare.revokePending")}</p>
      ) : null}
      <p className="fdy-cf-scope-summary">
        {requestedScopes
          ? t("cloudflare.scopeSummary", {
              asked: summary.asked,
              granted: summary.granted,
            })
          : t("cloudflare.scopeSummaryGranted", { granted: summary.granted })}
        {summary.write
          ? ` ${t("cloudflare.scopeSummaryWrite", { count: summary.write })}`
          : null}
      </p>
      <p className="fdy-xacc-muted">{t("cloudflare.foundryUses")}</p>
      {summary.granted ? (
        <details className="fdy-cf-scopes">
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            {t("cloudflare.viewPermissions")}
          </summary>
          <div className="fdy-cf-scopes-body">
            {summary.granted > filterThreshold ? (
              <label className="fdy-cf-scope-filter" htmlFor={filterId}>
                <span>{t("cloudflare.filterPermissions")}</span>
                <TextInput
                  id={filterId}
                  type="search"
                  tone="boxed"
                  value={filter}
                  placeholder={t("cloudflare.filterPlaceholder")}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
            ) : null}
            {groups.length ? (
              groups.map((group) => (
                <section key={group.area} className="fdy-cf-scope-group">
                  <h4>
                    {group.label} <small>{group.resources.length}</small>
                  </h4>
                  <ul>
                    {group.resources.map((resource) => (
                      <li key={resource.name}>
                        <code>{resource.name}</code>
                        <span className="fdy-cf-scope-actions">
                          {resource.actions.map((action) => (
                            <Badge
                              key={action}
                              dot={false}
                              tone={action === "read" ? "neutral" : "warn"}
                            >
                              {action}
                            </Badge>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="fdy-xacc-muted">
                {t("cloudflare.noPermissionMatch", { filter: filter.trim() })}
              </p>
            )}
          </div>
        </details>
      ) : null}
      <CloudflareActivity accountId={account.id} />
    </li>
  );
}
