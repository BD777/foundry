import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CloudflareActivityEntry } from "@bd777/foundry-protocol";
import { getCloudflareActivity } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { navigateToChat } from "../../lib/in-app-navigation";
import { errorText } from "./account-format";
import { cn } from "../../lib/cn";
import { ButtonRow } from "../../components/ui/button-row";
import { MutedText } from "../../components/ui/text";
import {
  identifierClass,
  scopesBodyClass,
  scopesDisclosureClass,
  scopesSummaryClass,
} from "./connector-layout";

const activityLineClass = "min-w-0 text-xs text-ink-muted wrap-anywhere";

const resultTone: Record<string, NonNullable<BadgeProps["tone"]>> = {
  succeeded: "online",
  failed: "error",
  refused: "warn",
};

/**
 * The identity's activity log (DEV-092): each change a session asked for
 * through Foundry, with its workspace, session, record and result, and
 * each change of a workspace's access level. Newest first.
 */
export function CloudflareActivity({ accountId }: { accountId: string }) {
  const { t, i18n } = useTranslation("externalAccounts");
  const [entries, setEntries] = useState<CloudflareActivityEntry[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    setError("");
    try {
      setEntries((await getCloudflareActivity(accountId)).entries);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [accountId]);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });
  const level = (name?: string) =>
    name === "dns_edit"
      ? t("cloudflare.accessDnsEdit")
      : name === "zero_trust"
        ? t("cloudflare.accessZeroTrust")
        : name === "read"
          ? t("cloudflare.accessRead")
          : (name ?? "");
  return (
    <details className={scopesDisclosureClass}>
      <summary className={scopesSummaryClass}>
        <ChevronRight size={14} aria-hidden="true" />
        {entries
          ? t("cloudflare.activityCount", { count: entries.length })
          : t("cloudflare.activity")}
      </summary>
      <div className={scopesBodyClass}>
        <ButtonRow align="end">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            {t("cloudflare.activityRefresh")}
          </Button>
        </ButtonRow>
        {error ? <Alert tone="error" title={error} /> : null}
        {entries && !entries.length ? (
          <MutedText>{t("cloudflare.activityEmpty")}</MutedText>
        ) : null}
        {entries?.length ? (
          <ol className="grid min-w-0 gap-2.5">
            {entries.map((entry) => (
              <li className="grid min-w-0 gap-0.5" key={entry.id}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 wrap-anywhere">
                  {entry.kind === "access_changed" ? (
                    <strong>
                      {t("cloudflare.activityAccessChanged", {
                        from: level(entry.from),
                        to: level(entry.to),
                      })}
                    </strong>
                  ) : (
                    <>
                      <code className={identifierClass}>{entry.method}</code>
                      <strong>
                        {[entry.recordType, entry.recordName]
                          .filter(Boolean)
                          .join(" ") || entry.path}
                      </strong>
                      {entry.content ? (
                        <code
                          className={cn(
                            identifierClass,
                            "min-w-0 text-ink-muted",
                          )}
                        >
                          {entry.content}
                        </code>
                      ) : null}
                      {entry.result ? (
                        <Badge dot={false} tone={resultTone[entry.result]}>
                          {t(`cloudflare.activityResult.${entry.result}`)}
                        </Badge>
                      ) : null}
                    </>
                  )}
                </div>
                <small className={activityLineClass}>
                  <time dateTime={entry.at}>{when(entry.at)}</time>
                  {" · "}
                  {entry.workspaceName || entry.workspaceId}
                  {entry.sessionId ? (
                    <>
                      {" · "}
                      <Button
                        size="inline"
                        variant="link"
                        onClick={() =>
                          navigateToChat(entry.sessionId!, entry.workspaceId)
                        }
                      >
                        {entry.sessionTitle || t("cloudflare.activitySession")}
                      </Button>
                    </>
                  ) : null}
                </small>
                {entry.error ? (
                  <small className={activityLineClass}>{entry.error}</small>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  );
}
