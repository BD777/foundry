import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { WorkspaceProjection } from "@bd777/foundry-protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { TextInput } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { workspaceDenial } from "../../lib/workspace-access";
import { i18n } from "../../i18n";

export function WorkspaceOverview({
  workspace,
  deviceOnline,
  deviceLabel,
  acceptedCount,
}: {
  workspace: WorkspaceProjection;
  deviceOnline: boolean;
  deviceLabel?: string;
  acceptedCount: number;
}) {
  const { t } = useTranslation("workspaces");
  const rescanDenial = workspaceDenial(workspace, "member");
  const [data, setData] = useState<WorkspaceInspection>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const [showWarnings, setShowWarnings] = useState(false);
  const sequence = useRef(0);
  async function load(rescan = false) {
    const request = ++sequence.current;
    setLoading(true);
    setScanning(rescan);
    setError("");
    try {
      const result = await inspectWorkspace(workspace.id, rescan);
      if (request === sequence.current) setData(result);
    } catch (failure) {
      if (request === sequence.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    setData(undefined);
    setQuery("");
    setLimit(30);
    if (workspace.id && deviceOnline) void load();
    return () => {
      sequence.current++;
    };
  }, [workspace.id, deviceOnline]);
  const inspection = data?.workspaceId === workspace.id ? data : undefined;
  const repositories = inspection?.repositories ?? [];
  const visible = repositories.filter((repo) =>
    `${repo.path} ${repo.kind} ${repo.status}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <Panel className="fdy-workspace-overview">
        <PanelHeader>
          <div>
            <h2>{t("overview.statusTitle")}</h2>
          </div>
          <Badge tone={deviceOnline ? "online" : "neutral"}>
            {deviceOnline
              ? t("overview.deviceOnline")
              : t("overview.deviceOffline")}
          </Badge>
        </PanelHeader>
        <dl className="fdy-workspace-facts">
          <div>
            <dt>{t("overview.rootRepository")}</dt>
            <dd>
              {inspection
                ? t(`overview.gitStates.${inspection.gitState}`)
                : loading
                  ? t("overview.checking")
                  : t("overview.unknown")}
            </dd>
          </div>
          <div>
            <dt>{t("overview.currentBranch")}</dt>
            <dd>
              {inspection
                ? inspection.branch ||
                  (inspection.head ? t("overview.detachedHead") : "—")
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("overview.trackedFiles")}</dt>
            <dd>
              {inspection?.trackedChanges === undefined
                ? t("overview.unknown")
                : inspection.trackedChanges
                  ? t("overview.uncommittedChanges")
                  : t("overview.clean")}
            </dd>
          </div>
          <div>
            <dt>{t("overview.uniqueRepositories")}</dt>
            <dd>
              {inspection?.scannedAt
                ? (inspection.uniqueRepositoryCount ?? t("overview.unknown"))
                : t("overview.notScanned")}
            </dd>
          </div>
          <div>
            <dt>{t("overview.device")}</dt>
            <dd>{deviceLabel ?? t("overview.noDevice")}</dd>
          </div>
          <div>
            <dt>{t("overview.acceptedIssues")}</dt>
            <dd>{acceptedCount}</dd>
          </div>
        </dl>
        {inspection?.gitState === "not_git" ? (
          <p>{t("overview.notGitNote")}</p>
        ) : null}
        {inspection?.gitState === "nested" ? (
          <p>
            <Trans
              t={t}
              i18nKey="overview.nestedNote"
              values={{ path: inspection.containingRepository }}
              components={{ code: <code /> }}
            />
          </p>
        ) : null}
        {inspection?.head ? (
          <p className="fdy-workspace-inspection-note">
            <Trans
              t={t}
              i18nKey="overview.checked"
              values={{
                head: inspection.head.slice(0, 12),
                time: new Date(inspection.inspectedAt).toLocaleString(
                  i18n.language,
                ),
              }}
              components={{ code: <code /> }}
            />
          </p>
        ) : null}
        <div className="fdy-workspace-inspection-actions">
          <Button
            onClick={() => void load()}
            disabled={loading || !deviceOnline || !workspace.id}
            variant="secondary"
          >
            {loading ? t("overview.checking") : t("overview.refreshStatus")}
          </Button>
        </div>
        {!deviceOnline ? (
          <p role="status">{t("overview.offlineNote")}</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </Panel>
      <Panel className="fdy-workspace-repositories">
        <PanelHeader>
          <div>
            <h2>{t("overview.repositoriesTitle")}</h2>
            <p>
              {inspection?.scannedAt
                ? t("overview.scanSummary", {
                    unique:
                      inspection.uniqueRepositoryCount == null
                        ? t("overview.uniqueUnknown")
                        : t("overview.uniqueCount", {
                            count: inspection.uniqueRepositoryCount,
                          }),
                    locations: t("overview.locationCount", {
                      count: repositories.length,
                    }),
                    worktrees:
                      inspection.linkedWorktreeCount == null
                        ? t("overview.worktreeUnknown")
                        : t("overview.worktreeCount", {
                            count: inspection.linkedWorktreeCount,
                          }),
                    time: new Date(inspection.scannedAt).toLocaleString(
                      i18n.language,
                    ),
                  })
                : t("overview.noScan")}
            </p>
            {rescanDenial ? <p role="note">{rescanDenial}</p> : null}
          </div>
          <Button
            disabled={
              loading || !deviceOnline || !workspace.id || !!rescanDenial
            }
            onClick={() => void load(true)}
            variant="secondary"
          >
            {loading && scanning
              ? t("overview.scanning")
              : t("overview.rescan")}
          </Button>
        </PanelHeader>
        <TextInput
          aria-label={t("overview.filterLabel")}
          placeholder={t("overview.filterPlaceholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(30);
          }}
        />
        <div className="fdy-workspace-repository-list">
          {visible.slice(0, limit).map((repo) => (
            <div className="fdy-workspace-repository-row" key={repo.id}>
              <div>
                <strong>
                  {repo.path === "." ? t("overview.rootWorkspace") : repo.path}
                </strong>
                <p>
                  {repo.kind}
                  {repo.linkedWorktree
                    ? ` · ${t("overview.linkedWorktree")}`
                    : ""}{" "}
                  · {repo.baseline}
                </p>
                {repo.error ? <p role="status">{repo.error}</p> : null}
              </div>
              <Badge tone={repo.status === "ready" ? "online" : "warn"}>
                {repo.status}
              </Badge>
            </div>
          ))}
          {!visible.length ? (
            <p>
              {query
                ? t("overview.noMatches")
                : inspection?.scannedAt
                  ? t("overview.noneFound")
                  : t("overview.rescanHint")}
            </p>
          ) : null}
        </div>
        {visible.length > limit ? (
          <Button
            onClick={() => setLimit((value) => value + 30)}
            variant="ghost"
          >
            {t("overview.showMore", { count: visible.length - limit })}
          </Button>
        ) : null}
        {inspection?.errors.length ? (
          <div>
            <Button
              variant="ghost"
              aria-expanded={showWarnings}
              onClick={() => setShowWarnings((value) => !value)}
            >
              {t("overview.scanWarnings", { count: inspection.errors.length })}
            </Button>
            {showWarnings
              ? inspection.errors.map((message, index) => (
                  <p key={index}>{message}</p>
                ))
              : null}
          </div>
        ) : null}
        <p className="fdy-workspace-inspection-note">
          {t("overview.footnote")}
        </p>
      </Panel>
    </>
  );
}
