import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExternalAccount } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import {
  accountUsable,
  customLabel,
  personName,
  relativeWhen,
  statusDetailText,
  statusLabel,
  statusTone,
} from "./account-format";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";

export type AccountAction =
  | "refresh"
  | "revoke"
  | "remove"
  | "reconnect"
  | "reauthorize"
  | "keep-alive-on"
  | "keep-alive-off";

/**
 * One connected account: who it is, where (organisation and app, unless the
 * group it sits in already says), its state, the workspaces bound to it and
 * whether Foundry keeps it alive. The frequent action is a button; the rest
 * sit in the row's menu, after app-level items the caller adds.
 */
export function AccountRow({
  account,
  place,
  canReauthorize,
  busy,
  onAction,
  appItems = [],
  children,
}: {
  account: ExternalAccount;
  /** Organisation and app, or "" when the surrounding group names them. */
  place: string;
  /** The account's app is on the page, so it can sign in again through it. */
  canReauthorize: boolean;
  busy: boolean;
  onAction: (action: AccountAction) => void;
  /** Items about the account's app, listed in the row's menu. */
  appItems?: RowMenuItem[];
  /** App-level notes and forms shown under the row. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("externalAccounts");
  const usable = accountUsable(account);
  const name = personName(account);
  const label = customLabel(account);
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
  const items: RowMenuItem[] = [
    ...(usable && canReauthorize
      ? [
          {
            key: "reauthorize",
            label: t("actions.reauthorize"),
            onSelect: () => onAction("reauthorize"),
          },
        ]
      : []),
    ...appItems,
    ...(account.status !== "revoked"
      ? [
          {
            key: "revoke",
            label: t("actions.revoke"),
            onSelect: () => onAction("revoke"),
            confirm: {
              title: t("actions.revokeTitle", { name }),
              body: t("actions.revokeBody"),
              action: t("actions.revoke"),
            },
          },
        ]
      : []),
    {
      key: "remove",
      label: t("actions.remove"),
      onSelect: () => onAction("remove"),
      confirm: {
        title: t("actions.removeTitle", { name }),
        body: t("actions.removeBody"),
        action: t("actions.remove"),
      },
    },
  ];
  return (
    <li className="fdy-xacc-row" data-status={account.status}>
      <div className="fdy-xacc-row-main">
        <div className="fdy-xacc-identity">
          <strong>{name}</strong>
          {label || place ? (
            <span>{[label, place].filter(Boolean).join(" · ")}</span>
          ) : null}
          <small>
            {[
              bound
                ? t("list.workspaces", { count: bound })
                : t("list.notBound"),
              lifetime,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
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
      {children}
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
          ) : canReauthorize ? (
            <Button
              disabled={busy}
              onClick={() => onAction("reconnect")}
              size="sm"
              variant="primary"
            >
              {t("actions.reconnect")}
            </Button>
          ) : null}
          <RowMenu
            disabled={busy}
            items={items}
            label={t("actions.more", { name })}
          />
        </span>
      </div>
    </li>
  );
}
