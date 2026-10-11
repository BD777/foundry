import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalProvider,
  ExternalProviderApp,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Checkbox } from "../../components/ui/field";
import {
  accountName,
  accountUsable,
  relativeWhen,
  statusDetailText,
  statusLabel,
  statusTone,
} from "./account-format";

export type AccountAction =
  | "refresh"
  | "revoke"
  | "remove"
  | "reconnect"
  | "keep-alive-on"
  | "keep-alive-off";

export function AccountRow({
  account,
  app,
  provider,
  busy,
  onAction,
}: {
  account: ExternalAccount;
  app?: ExternalProviderApp;
  provider?: ExternalProvider;
  busy: boolean;
  onAction: (action: AccountAction) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const usable = accountUsable(account);
  const name = accountName(account);
  const identity = [
    account.displayName || t("list.identityUnknown"),
    account.tenant ? t("list.tenant", { tenant: account.tenant }) : "",
    app ? t("list.app", { app: app.label }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const bound = account.workspaceIds?.length ?? 0;
  const lifetime = !usable
    ? account.lastRefreshedAt
      ? t("keepAlive.lastRefreshed", {
          when: relativeWhen(account.lastRefreshedAt),
        })
      : ""
    : account.keepAlive
      ? account.lastRefreshedAt
        ? t("keepAlive.on", { when: relativeWhen(account.lastRefreshedAt) })
        : t("keepAlive.onNever")
      : account.refreshExpiresAt
        ? t("keepAlive.off", { when: relativeWhen(account.refreshExpiresAt) })
        : t("keepAlive.offUnknown");
  const detail = statusDetailText(account);
  return (
    <li className="fdy-xacc-row" data-status={account.status}>
      <div className="fdy-xacc-row-main">
        <div className="fdy-xacc-identity">
          <strong>{name}</strong>
          <span>{identity}</span>
          <small>
            {[
              provider
                ? t("list.usedBy", {
                    provider: provider.label,
                    tools: provider.tools.join(", "),
                  })
                : account.provider,
              bound
                ? t("list.workspaces", { count: bound })
                : t("list.notBound"),
            ].join(" · ")}
          </small>
          {lifetime ? <small>{lifetime}</small> : null}
        </div>
        <Badge tone={statusTone(account.status)}>
          {statusLabel(account.status)}
        </Badge>
      </div>
      {detail ? (
        <p className="fdy-xacc-row-detail" role="status">
          {detail}
        </p>
      ) : null}
      <div className="fdy-xacc-row-actions">
        {usable ? (
          <label className="fdy-xacc-check">
            <Checkbox
              checked={account.keepAlive}
              disabled={busy}
              onChange={(event) =>
                onAction(
                  event.currentTarget.checked
                    ? "keep-alive-on"
                    : "keep-alive-off",
                )
              }
            />
            <span>{t("keepAlive.label")}</span>
          </label>
        ) : null}
        <span className="fdy-xacc-row-buttons">
          {usable ? (
            <Button
              disabled={busy}
              onClick={() => onAction("refresh")}
              size="sm"
            >
              {t("actions.refresh")}
            </Button>
          ) : app ? (
            <Button
              disabled={busy}
              onClick={() => onAction("reconnect")}
              size="sm"
              variant="primary"
            >
              {t("actions.reconnect")}
            </Button>
          ) : null}
          {account.status !== "revoked" ? (
            <ConfirmButton
              confirmLabel={t("actions.revokeConfirm")}
              disabled={busy}
              onConfirm={() => onAction("revoke")}
              size="sm"
            >
              {t("actions.revoke")}
            </ConfirmButton>
          ) : null}
          <ConfirmButton
            confirmLabel={t("actions.removeConfirm")}
            disabled={busy}
            onConfirm={() => onAction("remove")}
            size="sm"
            variant="ghost"
          >
            {t("actions.remove")}
          </ConfirmButton>
        </span>
      </div>
    </li>
  );
}
