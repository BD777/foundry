import { useEffect, useRef, useState } from "react";
import type { WorkspaceProjection } from "@foundry/protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { TextInput } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { workspaceDenial } from "../../lib/workspace-access";

const gitLabels = {
  ready: "Git initialized",
  unborn: "Git initialized · no initial commit",
  not_git: "Not a Git repository",
  nested: "Inside another Git repository",
  error: "Git unavailable",
};
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
            <h2>Workspace status</h2>
            <p>{workspace.contextSummary}</p>
          </div>
          <Badge tone={deviceOnline ? "online" : "neutral"}>
            {deviceOnline ? "Device online" : "Device offline"}
          </Badge>
        </PanelHeader>
        <dl className="fdy-workspace-facts">
          <div>
            <dt>Root repository</dt>
            <dd>
              {inspection
                ? gitLabels[inspection.gitState]
                : loading
                  ? "Checking…"
                  : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>Current branch</dt>
            <dd>
              {inspection
                ? inspection.branch || (inspection.head ? "Detached HEAD" : "—")
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Tracked files</dt>
            <dd>
              {inspection?.trackedChanges === undefined
                ? "Unknown"
                : inspection.trackedChanges
                  ? "Uncommitted changes"
                  : "Clean"}
            </dd>
          </div>
          <div>
            <dt>Unique repositories</dt>
            <dd>
              {inspection?.scannedAt
                ? (inspection.uniqueRepositoryCount ?? "Unknown")
                : "Not scanned"}
            </dd>
          </div>
          <div>
            <dt>Device</dt>
            <dd>{deviceLabel ?? "No device"}</dd>
          </div>
          <div>
            <dt>Accepted Issues</dt>
            <dd>{acceptedCount}</dd>
          </div>
        </dl>
        {inspection?.gitState === "not_git" ? (
          <p>
            Root Git is not initialized. Inspection and rescanning do not
            initialize Git or commit files.
          </p>
        ) : null}
        {inspection?.gitState === "nested" ? (
          <p>
            Containing repository:{" "}
            <code>{inspection.containingRepository}</code>. Issue isolation
            requires its repository root.
          </p>
        ) : null}
        {inspection?.head ? (
          <p className="fdy-workspace-inspection-note">
            HEAD <code>{inspection.head.slice(0, 12)}</code> · Checked{" "}
            {new Date(inspection.inspectedAt).toLocaleString()}
          </p>
        ) : null}
        <div className="fdy-workspace-inspection-actions">
          <Button
            onClick={() => void load()}
            disabled={loading || !deviceOnline || !workspace.id}
            variant="secondary"
          >
            {loading ? "Checking…" : "Refresh status"}
          </Button>
        </div>
        {!deviceOnline ? (
          <p role="status">
            Connect the device to inspect this workspace. No Git state is
            inferred while offline.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </Panel>
      <Panel className="fdy-workspace-repositories">
        <PanelHeader>
          <div>
            <h2>Git repositories</h2>
            <p>
              {inspection?.scannedAt
                ? `${inspection.uniqueRepositoryCount ?? "Unknown"} unique repositories · ${repositories.length} Git locations · ${inspection.linkedWorktreeCount ?? "Unknown"} linked worktrees · Last scanned ${new Date(inspection.scannedAt).toLocaleString()}`
                : "No repository scan has been recorded."}
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
              ? "Scanning repositories…"
              : "Rescan repositories"}
          </Button>
        </PanelHeader>
        <TextInput
          aria-label="Filter repositories"
          placeholder="Filter by path, type or status"
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
                  {repo.path === "." ? ". · Root workspace" : repo.path}
                </strong>
                <p>
                  {repo.kind}
                  {repo.linkedWorktree ? " · linked worktree" : ""} ·{" "}
                  {repo.baseline}
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
                ? "No matching repositories."
                : inspection?.scannedAt
                  ? "No Git repositories were found in the last scan."
                  : "Rescan to discover repositories without changing source files."}
            </p>
          ) : null}
        </div>
        {visible.length > limit ? (
          <Button
            onClick={() => setLimit((value) => value + 30)}
            variant="ghost"
          >
            Show more ({visible.length - limit} remaining)
          </Button>
        ) : null}
        {inspection?.errors.length ? (
          <div>
            <Button
              variant="ghost"
              aria-expanded={showWarnings}
              onClick={() => setShowWarnings((value) => !value)}
            >
              Scan warnings ({inspection.errors.length})
            </Button>
            {showWarnings
              ? inspection.errors.map((message, index) => (
                  <p key={index}>{message}</p>
                ))
              : null}
          </div>
        ) : null}
        <p className="fdy-workspace-inspection-note">
          Unique repositories share no Git common directory; locations include
          linked worktrees and uninitialized submodules. Repository statuses
          reflect the last scan. Scans skip symlinks and dependency/cache
          directories; only repos used by an Issue get candidate worktrees.
        </p>
      </Panel>
    </>
  );
}
