import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  WorkspaceExternalAccounts,
} from "@bd777/foundry-protocol";
import {
  getWorkspaceExternalAccounts,
  setWorkspaceExternalAccounts,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { Panel } from "../../components/ui/panel";
import {
  accountName,
  accountUsable,
  errorText,
  providerLabel,
  statusLabel,
  statusTone,
} from "./account-format";

export interface WorkspaceAccountsFeatureProps {
  workspaceId: string;
  currentUserId: string;
  /** Why the caller cannot change bindings (below Maintainer); still shown. */
  readOnlyReason?: string;
  onNotice: (message: string) => void;
  onOpenExternalAccounts: () => void;
}

/**
 * A workspace's Accounts tab: which of the caller's external accounts its
 * sessions may act as, and which accounts other members bound. Read on open
 * and after each change.
 */
export function WorkspaceAccountsFeature({
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
  onOpenExternalAccounts,
}: WorkspaceAccountsFeatureProps) {
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<WorkspaceExternalAccounts>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setView(undefined);
    setError("");
    getWorkspaceExternalAccounts(workspaceId)
      .then((next) => !cancelled && setView(next))
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const bound = new Set(view?.bindings.map((binding) => binding.accountId));
  const mine = (view?.accounts ?? []).filter(
    (account) => account.ownerUserId === currentUserId,
  );
  const others = (view?.accounts ?? []).filter(
    (account) => account.ownerUserId !== currentUserId && bound.has(account.id),
  );

  async function toggle(account: ExternalAccount, use: boolean) {
    const accountIds = mine
      .filter((entry) => (entry.id === account.id ? use : bound.has(entry.id)))
      .map((entry) => entry.id);
    setBusy(true);
    try {
      setView(await setWorkspaceExternalAccounts(workspaceId, accountIds));
      onNotice(
        t(use ? "workspace.bound" : "workspace.unbound", {
          name: accountName(account),
        }),
      );
    } catch (cause) {
      onNotice(t("workspace.saveFailed", { error: errorText(cause) }));
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return <Alert title={t("workspace.loadFailed", { error })} tone="error" />;
  if (!view)
    return (
      <p className="fdy-xacc-muted" role="status">
        {t("workspace.loading")}
      </p>
    );
  return (
    <div className="fdy-xacc-workspace">
      <p className="fdy-xacc-muted">{t("workspace.rule")}</p>
      {readOnlyReason ? <Alert title={readOnlyReason} tone="info" /> : null}
      <Panel className="fdy-xacc-section">
        <div className="fdy-xacc-section-head fdy-xacc-section-head-row">
          <strong>{t("workspace.mine")}</strong>
          <Button onClick={onOpenExternalAccounts} size="sm" variant="ghost">
            {mine.length ? t("workspace.manage") : t("workspace.connect")}
            <ChevronRight size={14} />
          </Button>
        </div>
        {mine.length === 0 ? (
          <p className="fdy-xacc-muted">{t("workspace.emptyMine")}</p>
        ) : (
          <ul className="fdy-xacc-list">
            {mine.map((account) => (
              <li className="fdy-xacc-binding-row" key={account.id}>
                <label className="fdy-xacc-check">
                  <Checkbox
                    checked={bound.has(account.id)}
                    disabled={busy || Boolean(readOnlyReason)}
                    onChange={(event) =>
                      void toggle(account, event.currentTarget.checked)
                    }
                  />
                  <span>
                    {t("workspace.use", { name: accountName(account) })}
                    {!accountUsable(account) ? (
                      <small>
                        {t("workspace.notUsable", {
                          status: statusLabel(account.status),
                        })}
                      </small>
                    ) : account.displayName ? (
                      <small>{account.displayName}</small>
                    ) : null}
                  </span>
                </label>
                <Badge tone={statusTone(account.status)}>
                  {statusLabel(account.status)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {others.length > 0 ? (
        <Panel className="fdy-xacc-section">
          <div className="fdy-xacc-section-head">
            <strong>{t("workspace.others")}</strong>
          </div>
          <ul className="fdy-xacc-list">
            {others.map((account) => (
              <li className="fdy-xacc-binding-row" key={account.id}>
                <span className="fdy-xacc-identity">
                  <strong>
                    {t("workspace.otherAccount", {
                      provider: providerLabel(account.provider),
                      name: account.label,
                    })}
                  </strong>
                </span>
                <Badge tone={statusTone(account.status)}>
                  {statusLabel(account.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
