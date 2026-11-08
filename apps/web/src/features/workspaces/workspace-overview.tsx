import { Alert } from "../../components/ui/alert";
import { WorkspaceServices } from "../../components/workspace/workspace-services";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { EmptyState } from "../../components/ui/empty-state";
import { workspaceDenial } from "../../lib/workspace-access";
import { i18n } from "../../i18n";
import { LoadingState } from "../../components/ui/loading";
import {
  migrationActive,
  migrationFailed,
  migrationFrozen,
} from "../../components/workspace/workspace-migration";
import { WorkspaceMoveDialog } from "../../components/workspace/workspace-move-dialog";
import { WorkspaceMoveSummary } from "../../components/workspace/workspace-move-progress";

const overviewPanel = "grid min-w-0 gap-[18px] p-5.5 max-[680px]:p-4";
const repositoryNote = "m-0 mt-[5px] text-xs text-ink-muted";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="mb-1.5 text-xs text-ink-muted">{label}</dt>
      <dd className="m-0 text-lg font-[650] [overflow-wrap:anywhere] text-ink">
        {children}
      </dd>
    </div>
  );
}

export function WorkspaceOverview({
  workspace,
  deviceOnline,
  deviceLabel,
  acceptedCount,
  devices = [],
  workspaces = [],
}: {
  workspace: WorkspaceProjection;
  deviceOnline: boolean;
  deviceLabel?: string;
  acceptedCount: number;
  /** For the move dialog: the devices to move to. */
  devices?: DeviceProjection[];
  /** For the move dialog: the folders beside which to suggest one. */
  workspaces?: WorkspaceProjection[];
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
  const [moveOpener, setMoveOpener] = useState<HTMLElement | null>();
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
  const moving = migrationActive(workspace.migration)
    ? workspace.migration
    : undefined;
  const failedMove = migrationFailed(workspace.migration)
    ? workspace.migration
    : undefined;
  const repositories = inspection?.repositories ?? [];
  const visible = repositories.filter((repo) =>
    `${repo.path} ${repo.kind} ${repo.status}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <Panel className={overviewPanel}>
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
        {moving ? (
          <Alert
            tone={migrationFrozen(moving) ? "warning" : "info"}
            size="compact"
            title={t("move.overviewTitle", {
              device: moving.targetDeviceLabel,
            })}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => setMoveOpener(event.currentTarget)}
              >
                {t("move.viewProgress")}
              </Button>
            }
          >
            <WorkspaceMoveSummary
              migration={moving}
              sourceLabel={deviceLabel ?? ""}
            />
            {migrationFrozen(moving)
              ? t("move.pausedNote", { device: moving.targetDeviceLabel })
              : null}
          </Alert>
        ) : null}
        {failedMove ? (
          <Alert
            tone="error"
            size="compact"
            title={t("move.lastFailed", {
              device: failedMove.targetDeviceLabel,
            })}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => setMoveOpener(event.currentTarget)}
              >
                {t("move.viewDetails")}
              </Button>
            }
          >
            {t("move.unchangedNote", { source: deviceLabel ?? "" })}
          </Alert>
        ) : null}
        {moveOpener !== undefined && workspace.migration ? (
          <WorkspaceMoveDialog
            workspace={workspace}
            devices={devices}
            workspaces={workspaces}
            migrationId={workspace.migration.id}
            returnFocusTo={moveOpener}
            onClose={() => setMoveOpener(undefined)}
          />
        ) : null}
        <dl className="m-0 grid grid-cols-3 gap-5 max-[680px]:grid-cols-2">
          <Fact label={t("overview.rootRepository")}>
            {inspection ? (
              t(`overview.gitStates.${inspection.gitState}`)
            ) : loading ? (
              <LoadingState label={t("overview.checking")} />
            ) : (
              t("overview.unknown")
            )}
          </Fact>
          <Fact label={t("overview.currentBranch")}>
            {inspection
              ? inspection.branch ||
                (inspection.head ? t("overview.detachedHead") : "—")
              : "—"}
          </Fact>
          <Fact label={t("overview.trackedFiles")}>
            {inspection?.trackedChanges === undefined
              ? t("overview.unknown")
              : inspection.trackedChanges
                ? t("overview.uncommittedChanges")
                : t("overview.clean")}
          </Fact>
          <Fact label={t("overview.uniqueRepositories")}>
            {inspection?.scannedAt
              ? (inspection.uniqueRepositoryCount ?? t("overview.unknown"))
              : t("overview.notScanned")}
          </Fact>
          <Fact label={t("overview.device")}>
            {deviceLabel ?? t("overview.noDevice")}
          </Fact>
          <Fact label={t("overview.acceptedIssues")}>{acceptedCount}</Fact>
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
          <FieldHint className="m-0 leading-[1.6]">
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
          </FieldHint>
        ) : null}
        <div>
          <Button
            busy={loading && !scanning}
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
        {error ? <Alert tone="error" size="compact" title={error} /> : null}
      </Panel>
      <WorkspaceServices
        workspaceId={workspace.id}
        canControl={!rescanDenial}
      />
      <Panel className={overviewPanel}>
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
            busy={loading && scanning}
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
        <div className="grid min-w-0">
          {visible.slice(0, limit).map((repo) => (
            <div
              className="flex items-center justify-between gap-4 border-b border-line py-[13px] text-sm"
              key={repo.id}
            >
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <strong>
                  {repo.path === "." ? t("overview.rootWorkspace") : repo.path}
                </strong>
                <p className={repositoryNote}>
                  {repo.kind}
                  {repo.linkedWorktree
                    ? ` · ${t("overview.linkedWorktree")}`
                    : ""}{" "}
                  · {repo.baseline}
                </p>
                {repo.error ? (
                  <p className={repositoryNote} role="status">
                    {repo.error}
                  </p>
                ) : null}
              </div>
              <Badge tone={repo.status === "ready" ? "online" : "warn"}>
                {repo.status}
              </Badge>
            </div>
          ))}
          {!visible.length ? (
            <EmptyState
              title={t(
                query
                  ? "overview.noMatchesTitle"
                  : "overview.noRepositoriesTitle",
              )}
              body={
                query
                  ? t("overview.noMatches")
                  : inspection?.scannedAt
                    ? t("overview.noneFound")
                    : t("overview.rescanHint")
              }
            />
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
        <FieldHint className="m-0 leading-[1.6]">
          {t("overview.footnote")}
        </FieldHint>
      </Panel>
    </>
  );
}
