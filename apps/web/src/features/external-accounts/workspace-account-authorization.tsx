import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalAccount,
  ExternalAccountsView,
} from "@bd777/foundry-protocol";
import { getExternalAccounts } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { errorText } from "./account-format";
import { AuthorizeDialog } from "./authorize-dialog";
import { ConnectDialog } from "./connect-dialog";
import { Skeleton } from "../../components/ui/loading";

/** Reuses server-held app registration/authorization, without navigating away. */
export function WorkspaceAccountAuthorization({
  account,
  onClose,
  onConnected,
}: {
  account?: ExternalAccount;
  onClose: () => void;
  onConnected: (account: ExternalAccount) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<ExternalAccountsView>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    getExternalAccounts()
      .then((v) => !cancelled && setView(v))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  if (error)
    return (
      <Alert tone="error" title={error}>
        <Button onClick={onClose} size="sm">
          {t("connect.cancel")}
        </Button>
      </Alert>
    );
  if (!view) return <Skeleton label={t("workspace.loading")} rows={2} />;
  const provider = view.providers.find((p) => p.kind === "feishu");
  if (account) {
    const app = view.apps.find((a) => a.id === account.appId);
    if (!app)
      return (
        <Alert tone="error" title={t("workspace.appUnavailable")}>
          <Button onClick={onClose} size="sm">
            {t("connect.cancel")}
          </Button>
        </Alert>
      );
    return (
      <AuthorizeDialog
        target={{ app, account }}
        provider={provider}
        onClose={onClose}
        onConnected={onConnected}
      />
    );
  }
  return (
    <ConnectDialog
      open
      onOpenChange={(open) => !open && onClose()}
      provider={provider}
      teamApps={view.apps.filter(
        (a) => a.provider === "feishu" && a.visibility === "instance",
      )}
      isAdmin={false}
      onAppCreated={(app) =>
        setView((v) => v && { ...v, apps: [...v.apps, app] })
      }
      onConnected={onConnected}
    />
  );
}
