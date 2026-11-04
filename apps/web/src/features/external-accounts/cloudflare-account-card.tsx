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
import { ButtonRow } from "../../components/ui/button-row";
import { MutedText } from "../../components/ui/text";
import {
  identifierClass,
  scopesBodyClass,
  scopesDisclosureClass,
  scopesSummaryClass,
} from "./connector-layout";

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
    <li className="fdy-xacc-row grid gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong className="min-w-0 wrap-anywhere">
          {account.displayName || account.label}
        </strong>
        <ButtonRow align="end" as="span">
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
        </ButtonRow>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-ink-muted">
        <span>
          {verified
            ? t("cloudflare.identityVerified")
            : t("cloudflare.needsAuth")}
        </span>
        {account.subject ? (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <code className={identifierClass}>{account.subject}</code>
            <CopyButton
              text={account.subject}
              label={t("cloudflare.copyUserId")}
              copiedLabel={t("cloudflare.copiedUserId")}
            />
          </span>
        ) : null}
      </div>
      {revokePending ? (
        <MutedText>{t("cloudflare.revokePending")}</MutedText>
      ) : null}
      <p className="text-xs">
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
      <MutedText>{t("cloudflare.foundryUses")}</MutedText>
      {summary.granted ? (
        <details className={scopesDisclosureClass}>
          <summary className={scopesSummaryClass}>
            <ChevronRight size={14} aria-hidden="true" />
            {t("cloudflare.viewPermissions")}
          </summary>
          <div className={scopesBodyClass}>
            {summary.granted > filterThreshold ? (
              <label className="grid max-w-80 gap-1" htmlFor={filterId}>
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
                <section key={group.area}>
                  <h4 className="mb-1 text-xs">
                    {group.label}{" "}
                    <small className="font-normal text-ink-muted">
                      {group.resources.length}
                    </small>
                  </h4>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-x-4 gap-y-1">
                    {group.resources.map((resource) => (
                      <li
                        className="flex min-w-0 items-center justify-between gap-2"
                        key={resource.name}
                      >
                        <code className={identifierClass}>{resource.name}</code>
                        <span className="inline-flex flex-none gap-1">
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
              <MutedText>
                {t("cloudflare.noPermissionMatch", { filter: filter.trim() })}
              </MutedText>
            )}
          </div>
        </details>
      ) : null}
      <CloudflareActivity accountId={account.id} />
    </li>
  );
}
