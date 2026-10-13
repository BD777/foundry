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
import { connectorTypes } from "../../lib/connector-types";
import { organisationLabel } from "../../lib/feishu-app-names";
import { navigateToConnectors } from "../../lib/in-app-navigation";
import {
  accountName,
  accountUsable,
  customLabel,
  errorText,
  personName,
  providerLabel,
  statusLabel,
  statusTone,
} from "./account-format";

export interface WorkspaceConnectorsFeatureProps {
  workspaceId: string;
  currentUserId: string;
  /** Why the caller cannot change bindings (below Maintainer); still shown. */
  readOnlyReason?: string;
  onNotice: (message: string) => void;
}

/**
 * A workspace's Connectors tab: per connector type, which of the caller's
 * accounts its sessions may act as, and which accounts other members bound.
 * Read on open and after each change.
 */
export function WorkspaceConnectorsFeature({
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
}: WorkspaceConnectorsFeatureProps) {
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
      {connectorTypes.map((type) => {
        const provider = providerLabel(type);
        const own = mine.filter((account) => account.provider === type);
        const theirs = others.filter((account) => account.provider === type);
        return (
          <Panel
            aria-label={provider}
            className="fdy-xacc-section"
            key={type}
            role="region"
          >
            <div className="fdy-xacc-section-head fdy-xacc-section-head-row">
              <span className="fdy-xacc-section-head">
                <strong>{provider}</strong>
                <p>{t(`workspace.binding.${type}`)}</p>
              </span>
              <Button
                onClick={() => navigateToConnectors(type)}
                size="sm"
                variant="ghost"
              >
                {own.length
                  ? t("workspace.manage")
                  : t("workspace.connect", { provider })}
                <ChevronRight size={14} />
              </Button>
            </div>
            {own.length === 0 ? (
              <p className="fdy-xacc-muted">
                {t("workspace.empty", { provider })}
              </p>
            ) : (
              <ul className="fdy-xacc-list">
                {own.map((account) => (
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
                        {t("workspace.use", { name: personName(account) })}
                        {customLabel(account) ||
                        account.appName ||
                        organisationLabel(account) ? (
                          <small>
                            {[
                              customLabel(account),
                              account.appName,
                              organisationLabel(account),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        ) : null}
                        {!accountUsable(account) ? (
                          <small>
                            {t("workspace.notUsable", {
                              status: statusLabel(account.status),
                            })}
                          </small>
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
            {theirs.length > 0 ? (
              <>
                <p className="fdy-xacc-muted">{t("workspace.others")}</p>
                <ul className="fdy-xacc-list">
                  {theirs.map((account) => (
                    <li className="fdy-xacc-binding-row" key={account.id}>
                      <span className="fdy-xacc-identity">
                        <strong>{account.label}</strong>
                      </span>
                      <Badge tone={statusTone(account.status)}>
                        {statusLabel(account.status)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>
        );
      })}
    </div>
  );
}
