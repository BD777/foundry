import { useTranslation } from "react-i18next";
import { listSkillRepositories } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/loading";
import type { ToastTone } from "../../components/ui/toast";
import { errorText } from "./account-format";
import { ConnectorPackage } from "./connector-package";
import type { useConnectorPackage } from "./use-connector-package";

/** The open connector's package panel: loading, a retryable failure, or the package. */
export function ConnectorPackagePanel({
  onAddInstance,
  onNotice,
  pkg,
}: {
  onAddInstance: () => void;
  onNotice: (message: string, tone?: ToastTone) => void;
  pkg: ReturnType<typeof useConnectorPackage>;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  if (pkg.loading)
    return (
      <Skeleton label={t("connectorPackage.loading")} rows={2} variant="rows" />
    );
  if (pkg.error)
    return (
      <Alert
        title={t("connectorPackage.loadFailed", { error: pkg.error })}
        tone="error"
      >
        <Button onClick={() => pkg.retry()} size="sm">
          {t("common:actions.retry")}
        </Button>
      </Alert>
    );
  if (!pkg.view) return null;
  return (
    <ConnectorPackage
      onAddInstance={onAddInstance}
      onNotice={onNotice}
      onSaved={(updated) => {
        pkg.setView(updated);
        void listSkillRepositories()
          .then((repositories) =>
            pkg.setRepository(
              repositories.find(
                (repository) => repository.id === updated.repositoryId,
              ),
            ),
          )
          .catch((cause: unknown) => onNotice(errorText(cause), "error"));
      }}
      repository={pkg.repository}
      view={pkg.view}
    />
  );
}
