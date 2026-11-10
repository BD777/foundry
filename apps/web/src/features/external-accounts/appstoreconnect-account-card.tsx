import type {
  AppStoreConnectApp,
  AppStoreConnectConnection,
  ExternalAccountStatus,
} from "@bd777/foundry-protocol";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { MutedText } from "../../components/ui/text";
import { statusLabel, statusTone } from "./account-format";
import { identifierClass } from "./connector-layout";

export function AppStoreConnectAccountCard({
  connection,
  apps,
  appsBusy,
  appsError,
  manage = true,
  onReplace,
  onRevoke,
  onRefreshApps,
}: {
  connection: AppStoreConnectConnection;
  apps?: AppStoreConnectApp[];
  appsBusy: boolean;
  appsError?: string;
  manage?: boolean;
  onReplace: () => void;
  onRevoke: () => void;
  onRefreshApps: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const active =
    connection.hasKey &&
    connection.status !== "revoked" &&
    connection.status !== "needs_reauth";
  const status: ExternalAccountStatus =
    connection.status === "ready" ||
    connection.status === "expiring" ||
    connection.status === "revoked"
      ? connection.status
      : "needs_reauth";
  return (
    <li className="fdy-xacc-row grid gap-2.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong className="min-w-0 wrap-anywhere">{connection.label}</strong>
        {manage ? (
          <ButtonRow align="end" as="span">
            <Button
              disabled={!active}
              onClick={onReplace}
              size="sm"
              variant="ghost"
            >
              {t("appstoreconnect.replace")}
            </Button>
            <Button
              disabled={!connection.hasKey && connection.status === "revoked"}
              onClick={onRevoke}
              size="sm"
              variant="ghost"
            >
              {t("appstoreconnect.revoke")}
            </Button>
          </ButtonRow>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
        <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
        <span>
          {t("appstoreconnect.issuer")}{" "}
          <code className={identifierClass}>{connection.issuerId}</code>
        </span>
        <span>
          {t("appstoreconnect.keyId")}{" "}
          <code className={identifierClass}>{connection.keyId}</code>
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <MutedText>
          {appsBusy
            ? t("appstoreconnect.loadingApps")
            : apps
              ? t("appstoreconnect.appCount", { count: apps.length })
              : t("appstoreconnect.appsNotRead")}
        </MutedText>
        <Button
          busy={appsBusy}
          disabled={!active}
          onClick={onRefreshApps}
          size="sm"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={13} />
          {t("appstoreconnect.refreshApps")}
        </Button>
      </div>
      {appsError ? (
        <Alert tone="error" title={appsError} />
      ) : apps?.length ? (
        <ul className="grid min-w-0 gap-1">
          {apps.map((app) => (
            <li
              className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
              key={app.id}
            >
              <strong className="min-w-0 wrap-anywhere">
                {app.name || t("appstoreconnect.unnamedApp", { id: app.id })}
              </strong>
              <code className={identifierClass}>{app.bundleId || app.id}</code>
            </li>
          ))}
        </ul>
      ) : (
        <MutedText>{t("appstoreconnect.noApps")}</MutedText>
      )}
    </li>
  );
}
