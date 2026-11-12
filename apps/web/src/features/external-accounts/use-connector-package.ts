import type {
  ConnectorDescriptor,
  ConnectorPackageDevice,
  ConnectorPackageView,
  SkillRepository,
} from "@bd777/foundry-protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConnectorPackages, listSkillRepositories } from "../../api";
import { errorText } from "./account-format";

const packageProgressPollMs = 3000;

function isApplying(device: ConnectorPackageDevice): boolean {
  return device.state === "pending" || device.state === "installing";
}

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

  // While the server applies the selection, follow each device's progress.
  useEffect(() => {
    if (!view || !view.devices.some(isApplying)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([getConnectorPackages(), listSkillRepositories()])
        .then(([packages, repositories]) => {
          if (cancelled) return;
          const next = packages.find((entry) => entry.connector.kind === kind);
          if (!next) return;
          setView(next);
          setRepository(
            repositories.find((item) => item.id === next.repositoryId),
          );
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorText(cause));
        });
    }, packageProgressPollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, kind]);

  /** Re-reads the package without the loading state, after its instances changed. */
  function refresh() {
    getConnectorPackages()
      .then((packages) => {
        const next = packages.find((entry) => entry.connector.kind === kind);
        if (next) setView(next);
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  }

  return {
    refresh,
    view,
    setView,
    repository,
    setRepository,
    loading,
    error,
    retry: () => setReload((value) => value + 1),
  };
}
