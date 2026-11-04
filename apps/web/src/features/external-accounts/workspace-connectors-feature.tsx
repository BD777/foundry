import type { ToastTone } from "../../components/ui/toast";
import { CloudflareConnector } from "./cloudflare-connector";
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
import { ConnectorSection } from "./connector-section";
import { CredentialHolding } from "./credential-holding";
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
import { WorkspaceAccountAuthorization } from "./workspace-account-authorization";
import { WorkspaceDeviceConnectors } from "./workspace-device-connectors";
import { Skeleton } from "../../components/ui/loading";
import { CheckLabel } from "../../components/ui/check-label";
import { DividedList } from "../../components/ui/divided-list";
import { Identity } from "../../components/ui/identity";
import { MutedText } from "../../components/ui/text";

export interface WorkspaceConnectorsFeatureProps {
  workspaceId: string;
  currentUserId: string;
  /** Why the caller cannot change bindings (below Maintainer); still shown. */
  readOnlyReason?: string;
  onNotice: (message: string, tone?: ToastTone) => void;
}

/**
 * A workspace's Connectors tab: per connector type, which of the caller's
 * accounts (server-held) or devices' sign-ins (device-held) its sessions
 * may use, and what other members bound. Read on open and after each change.
 */
export function WorkspaceConnectorsFeature(
  props: WorkspaceConnectorsFeatureProps,
) {
  return <WorkspaceConnectorsContent key={props.workspaceId} {...props} />;
}

function WorkspaceConnectorsContent({
  workspaceId,
  currentUserId,
  readOnlyReason,
  onNotice,
}: WorkspaceConnectorsFeatureProps) {
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<WorkspaceExternalAccounts>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState<{
    account?: ExternalAccount;
  }>();
  const [bindingRetry, setBindingRetry] = useState<ExternalAccount>();
  const [bindingError, setBindingError] = useState("");

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
    setBindingError("");
    const accountIds = mine
      .filter((entry) => (entry.id === account.id ? use : bound.has(entry.id)))
      .map((entry) => entry.id);
    if (use && !accountIds.includes(account.id)) accountIds.push(account.id);
    setBusy(true);
    try {
      setView(await setWorkspaceExternalAccounts(workspaceId, accountIds));
      setBindingRetry(undefined);
      onNotice(
        t(use ? "workspace.bound" : "workspace.unbound", {
          name: accountName(account),
        }),
      );
    } catch (cause) {
      const message = t("workspace.saveFailed", { error: errorText(cause) });
      setBindingError(message);
      if (use) setBindingRetry(account);
      onNotice(message);
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return <Alert title={t("workspace.loadFailed", { error })} tone="error" />;
  if (!view)
    return <Skeleton label={t("workspace.loading")} rows={3} variant="rows" />;
  return (
    <div className="grid min-w-0 gap-3.5">
      <MutedText>{t("workspace.rule")}</MutedText>
      {readOnlyReason ? <Alert title={readOnlyReason} tone="info" /> : null}
      {bindingError ? (
        <Alert title={bindingError} tone="error">
          {bindingRetry ? (
            <Button
              disabled={busy}
              size="sm"
              onClick={() => void toggle(bindingRetry, true)}
            >
              {t("workspace.retryBinding")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {authorizing ? (
        <WorkspaceAccountAuthorization
          key={authorizing.account?.id ?? "new"}
          account={authorizing.account}
          onClose={() => setAuthorizing(undefined)}
          onConnected={(account) => {
            setView(
              (current) =>
                current && {
                  ...current,
                  accounts: [
                    ...current.accounts.filter((a) => a.id !== account.id),
                    account,
                  ],
                },
            );
            void toggle(account, true);
          }}
        />
      ) : null}
      {serverHeldTypes.map((type) => {
        const provider = providerLabel(type);
        const own = mine.filter((account) => account.provider === type);
        const theirs = others.filter((account) => account.provider === type);
        return (
          <ConnectorSection
            actions={
              <>
                <Button
                  disabled={
                    busy || Boolean(readOnlyReason) || Boolean(authorizing)
                  }
                  size="sm"
                  variant={own.length ? "secondary" : "primary"}
                  onClick={() => setAuthorizing({})}
                >
                  {t("workspace.connect", { provider })}
                </Button>
                <Button
                  onClick={() => navigateToConnectors(type)}
                  size="sm"
                  variant="ghost"
                >
                  {t("workspace.manage")}
                  <ChevronRight size={14} />
                </Button>
              </>
            }
            description={t(`workspace.binding.${type}`)}
            holding={
              <CredentialHolding
                holding="server_held"
                name={t(`providers.${type}`)}
              />
            }
            key={type}
            name={provider}
          >
            {own.length === 0 ? (
              <MutedText>{t("workspace.empty", { provider })}</MutedText>
            ) : (
              <DividedList>
                {own.map((account) => (
                  <li
                    className="fdy-xacc-binding-row flex min-w-0 items-start justify-between gap-3"
                    key={account.id}
                  >
                    <CheckLabel>
                      <Checkbox
                        checked={bound.has(account.id)}
                        disabled={
                          busy ||
                          Boolean(readOnlyReason) ||
                          (!accountUsable(account) && !bound.has(account.id))
                        }
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
                    </CheckLabel>
                    {!accountUsable(account) ? (
                      <Button
                        disabled={busy || Boolean(readOnlyReason)}
                        size="sm"
                        onClick={() => setAuthorizing({ account })}
                      >
                        {t("workspace.authorize")}
                      </Button>
                    ) : null}
                    <Badge tone={statusTone(account.status)}>
                      {statusLabel(account.status)}
                    </Badge>
                  </li>
                ))}
              </DividedList>
            )}
            {theirs.length > 0 ? (
              <>
                <MutedText>{t("workspace.others")}</MutedText>
                <DividedList>
                  {theirs.map((account) => (
                    <li
                      className="fdy-xacc-binding-row flex min-w-0 items-start justify-between gap-3"
                      key={account.id}
                    >
                      <Identity as="span">
                        <strong>{account.label}</strong>
                      </Identity>
                      <Badge tone={statusTone(account.status)}>
                        {statusLabel(account.status)}
                      </Badge>
                    </li>
                  ))}
                </DividedList>
              </>
            ) : null}
          </ConnectorSection>
        );
      })}
      <CloudflareConnector
        workspaceId={workspaceId}
        workspaceView={view}
        onWorkspaceChanged={setView}
        currentUserId={currentUserId}
        readOnlyReason={readOnlyReason}
        onNotice={onNotice}
      />
      <WorkspaceDeviceConnectors
        key={workspaceId}
        currentUserId={currentUserId}
        onNotice={onNotice}
        readOnlyReason={readOnlyReason}
        workspaceId={workspaceId}
      />
    </div>
  );
}

const serverHeldTypes = ["feishu"] as const;
