import type {
  ConnectorDescriptor,
  ConnectorPackageView,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConnectorPackages, listSkillRepositories } from "../../api";
import { errorText } from "./account-format";

/**
 * The package panel of the open connector: a detail of its catalog entry.
 * Connectors without a package declaration do not ask the package API.
 */
export function useConnectorPackage(
  catalog: ConnectorDescriptor[] | undefined,
  kind: string,
) {
  const { t } = useTranslation("externalAccounts");
  const [view, setView] = useState<ConnectorPackageView>();
  const [repository, setRepository] = useState<SkillRepository>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const packaged = catalog?.find((entry) => entry.kind === kind)?.package;
    if (!packaged) {
      setView(undefined);
      setRepository(undefined);
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([getConnectorPackages(), listSkillRepositories()])
      .then(([packages, repositories]) => {
        if (cancelled) return;
        const next = packages.find((entry) => entry.connector.kind === kind);
        if (!next) {
          setView(undefined);
          setRepository(undefined);
          setError(t("connectorPackage.notListed"));
          return;
        }
        setView(next);
        setRepository(
          repositories.find((item) => item.id === next.repositoryId),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, reload, kind]);

  return {
    view,
    setView,
    repository,
    setRepository,
    loading,
    error,
    retry: () => setReload((value) => value + 1),
  };
}
