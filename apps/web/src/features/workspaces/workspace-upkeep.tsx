import { toast } from "../../components/ui/toast";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ContextPatchReply,
  MaintenancePatch,
  PersonalAgentContextPatch,
  PersonalAgentMaintenance,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  actOnWorkspaceUpkeep,
  applyWorkspaceUpkeepPatch,
  listWorkspaceUpkeep,
  previewWorkspaceUpkeepPatch,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import { ClampedText } from "../../components/ui/clamped-text";
import { Dialog } from "../../components/ui/dialog";
import { DividedList } from "../../components/ui/divided-list";
import { FieldHint } from "../../components/ui/field";
import { FileDiff } from "../../components/ui/file-diff";
import { LoadingState, Spinner } from "../../components/ui/loading";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { Subheading } from "../../components/ui/subheading";
import { cn } from "../../lib/cn";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { workspaceDenial } from "../../lib/workspace-access";
import {
  firstSentence,
  sourceRef,
  summaryBody,
} from "./workspace-upkeep-model";
import {
  ArrowUpRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  FilePenLine,
  GitMerge,
  Hourglass,
  RotateCcw,
  X,
} from "lucide-react";

const upkeepPanel = "grid min-w-0 gap-4 p-5.5 max-[680px]:p-4";
/** Accepted changes no longer wait for the person; a conflict still does. */
const decidedStates = ["applying", "applied"];
/** Reviews shown before 「查看全部」. */
const shownReviews = 3;

/** A suggested change the person has not decided yet. */
function undecided(
  job: PersonalAgentMaintenance,
  patches: PersonalAgentContextPatch[],
): number {
  if (job.status !== "review" || !job.result) return 0;
  return job.result.patches.reduce((count, _patch, index) => {
    const operation = patches.find(
      (candidate) => candidate.jobId === job.id && candidate.index === index,
    );
    return (
      count + (operation && decidedStates.includes(operation.status) ? 0 : 1)
    );
  }, 0);
}

/** The mark that says what happened: shape and tone, plus the status in words. */
function StatusMark({ status }: { status: string }) {
  if (status === "running" || status === "starting")
    return (
      <span className="mt-[3px] flex h-4 w-4 flex-none items-center justify-center">
        <Spinner size={14} />
      </span>
    );
  const { icon: Icon, tone } = {
    pending: { icon: Hourglass, tone: "text-warning-text" },
    waiting: { icon: Hourglass, tone: "text-warning-text" },
    review: { icon: FilePenLine, tone: "text-brand-dark" },
    failed: { icon: CircleAlert, tone: "text-error-text" },
    conflict: { icon: CircleAlert, tone: "text-error-text" },
    complete: { icon: CircleCheck, tone: "text-success-text" },
    applied: { icon: CircleCheck, tone: "text-success-text" },
    dismissed: { icon: CircleX, tone: "text-ink-faint" },
    superseded: { icon: GitMerge, tone: "text-ink-faint" },
  }[status] ?? { icon: FilePenLine, tone: "text-ink-faint" };
  return (
    <Icon
      aria-hidden="true"
      className={cn("mt-[3px] size-4 flex-none", tone)}
      strokeWidth={1.8}
    />
  );
}

interface PatchTarget {
  jobId: string;
  revision: number;
  index: number;
  path: string;
  reason: string;
  content: string;
  baseHash: string;
}

/**
 * 「项目维护」: Foundry's reviews of this project's instruction files and the
 * file changes they suggest, on the project's own page (DEV-256, DEV-263). It
 * is the project's, not any assistant's, so it is shown to its owner whether
 * or not an assistant is running. A review is one collapsed row; its prose,
 * findings and suggested changes open under it, and a suggested change opens
 * its diff before anything is written. Applying still waits for no active
 * conversation in the project, which the server enforces.
 */
export function WorkspaceUpkeep({
  workspace,
}: {
  workspace: WorkspaceProjection;
}) {
  const { t } = useTranslation("workspaces");
  const { t: tm } = useTranslation("personalAgent");
  const denial = workspaceDenial(workspace, "owner");
  const [jobs, setJobs] = useState<PersonalAgentMaintenance[]>([]);
  const [patches, setPatches] = useState<PersonalAgentContextPatch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [showAll, setShowAll] = useState(false);
  /** Undefined until the person opens or closes a row; the newest open review shows until then. */
  const [chosenOpen, setChosenOpen] = useState<string | null>();
  const [target, setTarget] = useState<PatchTarget>();
  const [source, setSource] = useState<ContextPatchReply>();
  const [previewError, setPreviewError] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const read = useCallback(async () => {
    const upkeep = await listWorkspaceUpkeep(workspace.id);
    setJobs(upkeep.jobs);
    setPatches(upkeep.patches);
  }, [workspace.id]);
  useEffect(() => {
    if (!workspace.id || denial) return;
    let cancelled = false;
    read()
      .then(() => {
        if (!cancelled) setError("");
      })
      .catch((e) => {
        if (!cancelled) setError(serverErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [read, workspace.id, denial]);
  const active =
    jobs.some((job) =>
      ["pending", "waiting", "starting", "running"].includes(job.status),
    ) || patches.some((patch) => patch.status === "applying");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () =>
        void read().catch((e) => {
          setError(serverErrorText(e));
        }),
      10000,
    );
    return () => clearInterval(timer);
  }, [active, read]);
  if (denial) return null;
  async function perform(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await action();
      await read();
    } catch (e) {
      toast({
        tone: "error",
        title: t("upkeep.title"),
        description: serverErrorText(e),
      });
    } finally {
      setBusy("");
    }
  }
  function status(value: string) {
    const known = [
      "pending",
      "waiting",
      "starting",
      "running",
      "review",
      "complete",
      "failed",
      "dismissed",
      "superseded",
      "applying",
      "applied",
      "conflict",
    ];
    return known.includes(value)
      ? tm(`maintenance.states.${value}` as never)
      : value;
  }
  function reason(value: string) {
    const known = [
      "assistant_paused",
      "no_default_assistant",
      "maintenance_busy",
      "daily_maintenance_limit",
      "role_configuration_unavailable",
      "role_configuration_changed",
      "device_offline",
      "target_device_offline",
      "device_offline_too_long",
      "workspace_archived",
      "workspace_unavailable",
      "workspace_gone",
      "source_gone",
      "source_inactive",
      "retry_scheduled",
      "worker_update_required",
      "source_unavailable",
      "sandbox_unavailable",
      "account_unavailable",
      "input_acceptance_failed",
      "invalid_review_result",
      "native_failed",
      "native_canceled",
      "waiting_for_device_receipt",
      "source_changed_review_again",
      "permission_changed",
      "source_location_changed",
      "receipt_mismatch",
      "input_moved",
    ];
    return known.includes(value)
      ? tm(`maintenance.reasons.${value}` as never)
      : value;
  }
  async function previewTarget(next: PatchTarget) {
    setTarget(next);
    setSource(undefined);
    setPreviewError("");
    setApplyError("");
    setBusy(`${next.jobId}:${next.index}`);
    try {
      setSource(
        await previewWorkspaceUpkeepPatch(
          workspace.id,
          next.jobId,
          next.revision,
          next.index,
        ),
      );
    } catch (e) {
      setPreviewError(serverErrorText(e));
    } finally {
      setBusy("");
    }
  }
  function openPatch(
    job: PersonalAgentMaintenance,
    patch: MaintenancePatch,
    index: number,
  ) {
    void previewTarget({
      jobId: job.id,
      revision: job.revision,
      index,
      path: patch.path,
      reason: patch.reason,
      content: patch.content,
      baseHash: patch.baseHash,
    });
  }
  function closePatch() {
    setTarget(undefined);
    setSource(undefined);
    setPreviewError("");
    setApplyError("");
  }
  async function applyPatch() {
    if (!target || !source) return;
    setApplying(true);
    setApplyError("");
    try {
      await applyWorkspaceUpkeepPatch(
        workspace.id,
        target.jobId,
        target.revision,
        target.index,
        source.hash,
      );
      closePatch();
      await read();
    } catch (e) {
      setApplyError(serverErrorText(e));
    } finally {
      setApplying(false);
    }
  }
  const waiting = jobs.reduce(
    (count, job) => count + undecided(job, patches),
    0,
  );
  const ordered = [...jobs].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const newestOpen =
    ordered.find(
      (job) => job.status === "review" && undecided(job, patches) > 0,
    )?.id ?? null;
  const openId = chosenOpen === undefined ? newestOpen : chosenOpen;
  const visible = showAll ? ordered : ordered.slice(0, shownReviews);
  const hidden = ordered.length - visible.length;
  function rowTitle(job: PersonalAgentMaintenance) {
    return (
      (job.status !== "failed" && job.result?.summary
        ? firstSentence(job.result.summary)
        : "") || status(job.status)
    );
  }
  function rowMeta(job: PersonalAgentMaintenance): ReactNode {
    const when = (
      <time
        className="tabular-nums"
        dateTime={job.createdAt}
        title={fullWhen(job.createdAt)}
      >
        {relativeWhen(job.createdAt)}
      </time>
    );
    if (!job.result) {
      return (
        <>
          {when}
          <span aria-hidden="true"> · </span>
          {job.reason ? reason(job.reason) : status(job.status)}
        </>
      );
    }
    return (
      <>
        {when}
        {job.result.patches.length ? (
          <>
            <span aria-hidden="true"> · </span>
            {t("upkeep.suggestion", { count: job.result.patches.length })}
          </>
        ) : null}
        <span aria-hidden="true"> · </span>
        {status(job.status)}
      </>
    );
  }
  function menuFor(job: PersonalAgentMaintenance): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    if (job.sessionId)
      items.push({
        key: "open",
        label: tm("maintenance.openRun"),
        icon: <ArrowUpRight aria-hidden="true" size={15} />,
        onSelect: () => navigateToChat(job.sessionId!, job.workspaceId),
      });
    if (["failed", "waiting"].includes(job.status) && job.attempt < 2)
      items.push({
        key: "retry",
        label: tm("maintenance.retry"),
        icon: <RotateCcw aria-hidden="true" size={15} />,
        onSelect: () =>
          void perform(job.id, () =>
            actOnWorkspaceUpkeep(workspace.id, job.id, job.revision, "retry"),
          ),
      });
    if (
      ["review", "failed", "pending", "waiting"].includes(job.status) &&
      (!job.inputId || ["review", "failed"].includes(job.status))
    )
      items.push({
        key: "dismiss",
        label: tm("maintenance.dismiss"),
        icon: <X aria-hidden="true" size={15} />,
        onSelect: () =>
          void perform(job.id, () =>
            actOnWorkspaceUpkeep(workspace.id, job.id, job.revision, "dismiss"),
          ),
      });
    return items;
  }
  function jobRow(job: PersonalAgentMaintenance) {
    const expandable =
      Boolean(job.result) &&
      !["failed", "waiting", "pending", "starting", "running"].includes(
        job.status,
      );
    const open = expandable && openId === job.id;
    const contentId = `upkeep-review-${job.id}`;
    const body = job.result ? summaryBody(job.result.summary) : "";
    return (
      <li className="fdy-upkeep-row grid min-w-0 gap-2" key={job.id}>
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusMark status={job.status} />
          {expandable ? (
            <Button
              aria-controls={contentId}
              aria-expanded={open}
              className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-start justify-start gap-x-2 gap-y-0.5 rounded-md px-1 py-0 text-left hover:bg-hover-2 active:scale-100"
              onClick={() => setChosenOpen(open ? null : job.id)}
              variant="bare"
            >
              <span className="col-start-1 w-full min-w-0 truncate text-sm leading-[1.45] font-semibold text-ink">
                {rowTitle(job)}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "col-start-2 row-span-2 row-start-1 mt-0.5 size-4 flex-none text-ink-faint transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
              <span className="col-start-1 row-start-2 flex w-full min-w-0 flex-wrap items-center gap-x-1 text-xs leading-[1.4] text-ink-faint">
                {rowMeta(job)}
              </span>
            </Button>
          ) : (
            <div className="grid min-w-0 flex-1 justify-items-start gap-0.5 px-1 py-0">
              <span className="w-full min-w-0 truncate text-sm leading-[1.45] font-semibold text-ink">
                {rowTitle(job)}
              </span>
              <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1 text-xs leading-[1.4] text-ink-faint">
                {rowMeta(job)}
              </span>
            </div>
          )}
          <RowMenu
            disabled={Boolean(busy)}
            items={menuFor(job)}
            label={t("upkeep.actionsFor", { title: rowTitle(job) })}
          />
        </div>
        {open && job.result ? (
          <div
            className="grid min-w-0 gap-3 ps-[30px] max-[680px]:ps-[26px]"
            id={contentId}
          >
            {body ? <ClampedText>{body}</ClampedText> : null}
            {job.result.findings.length ? (
              <section className="grid min-w-0 gap-1.5">
                <Subheading as="h4" size="caption">
                  {t("upkeep.findings")}
                </Subheading>
                <ul className="grid min-w-0 list-none gap-2.5 p-0">
                  {job.result.findings.map((finding, index) => (
                    <li className="grid min-w-0 gap-1" key={index}>
                      <ClampedText clamp={2}>{finding.summary}</ClampedText>
                      {finding.sourceRefs.length ? (
                        <span className="flex min-w-0 flex-wrap gap-1">
                          {finding.sourceRefs.map((ref) => {
                            const { file, section } = sourceRef(ref);
                            return (
                              <Chip key={ref}>
                                {section ? `${file} › ${section}` : file}
                              </Chip>
                            );
                          })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {job.status === "review" && job.result.patches.length ? (
              <section className="grid min-w-0 gap-1.5">
                <Subheading as="h4" size="caption">
                  {t("upkeep.suggestions")}
                </Subheading>
                <ul className="grid min-w-0 list-none gap-2.5 p-0">
                  {job.result.patches.map((patch, index) => {
                    const operation = patches.find(
                      (candidate) =>
                        candidate.jobId === job.id && candidate.index === index,
                    );
                    return (
                      <li
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1"
                        key={patch.path}
                      >
                        <div className="grid min-w-0 gap-0.5">
                          <span
                            className="min-w-0 truncate font-mono text-sm text-ink"
                            title={patch.path}
                          >
                            {patch.path}
                          </span>
                          <ClampedText clamp={2} size="xs">
                            {patch.reason}
                          </ClampedText>
                          {operation ? (
                            <FieldHint className="m-0">
                              {status(operation.status)}
                              {operation.reason
                                ? ` · ${reason(operation.reason)}`
                                : ""}
                            </FieldHint>
                          ) : null}
                        </div>
                        {operation ? null : (
                          <Button
                            disabled={Boolean(busy)}
                            onClick={() => void openPatch(job, patch, index)}
                            size="sm"
                            variant="secondary"
                          >
                            {t("upkeep.reviewChange")}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  }
  const baseHash = target ? target.baseHash || "missing" : "";
  const stale = Boolean(source && source.hash !== baseHash);
  return (
    <Panel className={upkeepPanel}>
      <PanelHeader>
        <div>
          <h2>{t("upkeep.title")}</h2>
          <p>{t("upkeep.description")}</p>
        </div>
        {waiting > 0 ? (
          <Badge tone="warn">{t("upkeep.waiting", { count: waiting })}</Badge>
        ) : null}
      </PanelHeader>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      {!jobs.length ? (
        <FieldHint className="m-0 leading-[1.6]">{t("upkeep.empty")}</FieldHint>
      ) : (
        <DividedList density="cozy">{visible.map(jobRow)}</DividedList>
      )}
      {hidden > 0 || showAll ? (
        <Button
          aria-expanded={showAll}
          className="justify-self-start"
          onClick={() => setShowAll((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {showAll
            ? t("upkeep.showLess")
            : t("upkeep.showAll", { count: ordered.length })}
        </Button>
      ) : null}
      {target ? (
        <Dialog
          busy={applying}
          description={target.reason}
          footer={
            <>
              <Button
                disabled={applying}
                onClick={closePatch}
                variant="secondary"
              >
                {t("upkeep.notNow")}
              </Button>
              {source && !stale ? (
                <Button
                  busy={applying}
                  onClick={() => void applyPatch()}
                  variant="primary"
                >
                  {t("upkeep.apply")}
                </Button>
              ) : null}
            </>
          }
          onClose={closePatch}
          size="wide"
          title={target.path}
        >
          {stale ? (
            <Alert tone="warning" title={tm("maintenance.stale")} />
          ) : null}
          {source && !stale ? (
            <FieldHint className="m-0">
              {source.hash === "missing"
                ? tm("maintenance.newFile")
                : tm("maintenance.modifiedFile")}
            </FieldHint>
          ) : null}
          {previewError ? (
            <Alert
              actions={
                <Button
                  onClick={() => void previewTarget(target)}
                  size="sm"
                  variant="secondary"
                >
                  {tm("maintenance.retry")}
                </Button>
              }
              size="compact"
              title={t("upkeep.previewFailed")}
              tone="error"
            >
              {previewError}
            </Alert>
          ) : !source ? (
            <LoadingState label={t("upkeep.loadingChange")} />
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <div className="min-w-[480px]">
                <FileDiff
                  after={target.content}
                  before={
                    source.hash === "missing" ? "" : (source.content ?? "")
                  }
                  errorCopy="file"
                />
              </div>
            </div>
          )}
          {applyError ? (
            <Alert size="compact" title={applyError} tone="error" />
          ) : null}
        </Dialog>
      ) : null}
    </Panel>
  );
}
