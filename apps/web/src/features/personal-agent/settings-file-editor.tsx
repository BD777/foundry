import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Pencil } from "lucide-react";
import type {
  AssistantFile,
  AssistantWorkspace,
  WorkspaceFileRevision,
} from "@bd777/foundry-protocol";
import {
  answerAssistantInstructionsDefault,
  fetchFileDownload,
  moveAssistantFile,
  readAssistantFile,
  revertAssistantFile,
  saveAssistantFile,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, Textarea } from "../../components/ui/field";
import { FieldLabel } from "../../components/ui/form-field";
import { FileDiff } from "../../components/ui/file-diff";
import { Skeleton } from "../../components/ui/loading";
import { RowMenu } from "../../components/ui/row-menu";
import { ToastFeedback } from "../../components/ui/toast";
import { TextFileView } from "../../components/workspace/workspace-file-view";
import { WorkspaceImagePreview } from "../../components/workspace/workspace-image-preview";
import { isInlineImageCandidate } from "../../components/workspace/image-preview-model";
import { cn } from "../../lib/cn";
import { serverErrorText } from "../../lib/errors";
import { clockTime } from "../../lib/time-format";
import { PaMuted } from "./pa-muted";
import {
  History,
  isConflict,
  RenameDialog,
  size,
  utf8Bytes,
} from "./settings-file-history";

async function download(
  workspaceId: string,
  path: string,
  onError: (message: string) => void,
): Promise<void> {
  const controller = new AbortController();
  try {
    const response = await fetchFileDownload(
      { workspaceId, path },
      controller.signal,
    );
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").pop() || path;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (reason) {
    onError(serverErrorText(reason));
  }
}

/** One file: its content, editing with the version seen, and its history. */
export function FileEditor({
  assistantId,
  onBack,
  onDeleted,
  onNotice,
  onRenamed,
  onSaved,
  path,
  workspace,
}: {
  assistantId?: string;
  onBack: () => void;
  onDeleted: () => void;
  onNotice: (message: string) => void;
  onRenamed: (path: string) => void;
  onSaved: () => void;
  path: string;
  workspace: AssistantWorkspace;
}) {
  const { t } = useTranslation("personalAgent");
  const [file, setFile] = useState<AssistantFile>();
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** The file as the computer has it, when a save found it changed. */
  const [theirs, setTheirs] = useState<AssistantFile>();
  const [restoring, setRestoring] = useState<WorkspaceFileRevision>();
  const [renaming, setRenaming] = useState(false);
  const [showBlock, setShowBlock] = useState(false);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    readAssistantFile(assistantId, workspace.id, path).then(
      (read) => {
        if (!cancelled) setFile(read);
      },
      (reason: unknown) => {
        if (!cancelled) setLoadError(reason);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assistantId, workspace.id, path, attempt]);

  const reread = useCallback(
    () => readAssistantFile(assistantId, workspace.id, path),
    [assistantId, workspace.id, path],
  );

  async function save(content: string, base: string): Promise<void> {
    setSaving(true);
    setError("");
    try {
      setFile(
        await saveAssistantFile(assistantId, {
          workspaceId: workspace.id,
          path,
          content,
          baseSha256: base,
        }),
      );
      setDraft(undefined);
      setTheirs(undefined);
      onSaved();
      onNotice(t("settings.files.saved", { path }));
    } catch (reason) {
      if (isConflict(reason)) {
        try {
          setTheirs(await reread());
        } catch (again) {
          setError(serverErrorText(again));
        }
      } else setError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function restore(revision: WorkspaceFileRevision): Promise<void> {
    if (!file) return;
    setSaving(true);
    setError("");
    try {
      setFile(
        await revertAssistantFile(assistantId, {
          workspaceId: workspace.id,
          path,
          revisionId: revision.id,
          baseSha256: file.sha256,
        }),
      );
      onSaved();
      onNotice(
        t("settings.files.restored", {
          when: clockTime(revision.at, { date: "short" }),
        }),
      );
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setRestoring(undefined);
      setSaving(false);
    }
  }

  async function answerDefault(adopt: boolean): Promise<void> {
    if (!file) return;
    setSaving(true);
    setError("");
    try {
      setFile(
        await answerAssistantInstructionsDefault(assistantId, {
          adopt,
          baseSha256: file.sha256,
        }),
      );
      setComparing(false);
      onNotice(
        adopt
          ? t("settings.files.newDefault.adopted")
          : t("settings.files.newDefault.kept"),
      );
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!file) return;
    setSaving(true);
    setError("");
    try {
      await moveAssistantFile(assistantId, {
        workspaceId: workspace.id,
        path,
        baseSha256: file.sha256,
      });
      onNotice(t("settings.files.deleted", { path }));
      onDeleted();
    } catch (reason) {
      setError(serverErrorText(reason));
      setSaving(false);
    }
  }

  const back = (
    <Button
      className="justify-self-start lg:hidden"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      <ArrowLeft aria-hidden="true" size={14} />
      {t("settings.files.backToTree")}
    </Button>
  );
  if (loadError !== undefined && !file)
    return (
      <div className="grid gap-3 p-4">
        {back}
        <Alert
          actions={
            <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
              {t("settings.files.retry")}
            </Button>
          }
          size="compact"
          title={t("settings.files.readFailed")}
          tone="error"
        >
          {serverErrorText(loadError)}
        </Alert>
      </div>
    );
  if (!file)
    return (
      <div className="grid gap-3 p-4">
        {back}
        <Skeleton
          className="h-48"
          label={t("settings.files.loading", { path })}
        />
      </div>
    );

  const instructions = file.instructions;
  const editing = draft !== undefined;
  const editable = !file.readOnly && (!file.missing || !!instructions);
  const canManage =
    workspace.canManage &&
    !instructions &&
    file.readOnly !== "generated" &&
    file.readOnly !== "foundry_skill" &&
    !file.missing;
  const bytes = instructions
    ? instructions.bytes -
      utf8Bytes(file.content) +
      utf8Bytes(draft ?? file.content)
    : 0;
  const overBudget = !!instructions && bytes > instructions.maxBytes;
  const binary = file.readOnly === "binary";

  return (
    <article className="grid min-w-0 content-start gap-4 p-4">
      {back}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4
          className="min-w-0 truncate font-mono text-sm font-semibold text-ink"
          title={path}
        >
          {path}
        </h4>
        <ButtonRow className="gap-1">
          {binary ? (
            <Button
              onClick={() => void download(workspace.id, path, setError)}
              size="sm"
              variant="ghost"
            >
              <Download aria-hidden="true" size={14} />
              {t("settings.files.download")}
            </Button>
          ) : null}
          {editable && !editing ? (
            <Button
              disabled={saving}
              onClick={() => {
                setError("");
                setTheirs(undefined);
                setDraft(file.content);
              }}
              size="sm"
              variant="secondary"
            >
              <Pencil aria-hidden="true" size={14} />
              {t("settings.files.edit")}
            </Button>
          ) : null}
          {canManage ? (
            <RowMenu
              disabled={saving || editing}
              items={[
                {
                  key: "rename",
                  label: t("settings.files.rename"),
                  onSelect: () => setRenaming(true),
                },
                {
                  key: "delete",
                  label: t("settings.files.delete"),
                  tone: "danger",
                  confirm: {
                    title: t("settings.files.deleteTitle", { path }),
                    body: t("settings.files.deleteBody"),
                    action: t("settings.files.deleteAction"),
                  },
                  onSelect: () => void remove(),
                },
              ]}
              label={t("settings.files.actions", { path })}
            />
          ) : null}
        </ButtonRow>
      </div>

      {file.readOnly && !binary ? (
        <Alert
          size="compact"
          title={t(`settings.files.readOnly.${file.readOnly}`)}
          tone={file.readOnly === "whole_file" ? "warning" : "info"}
        />
      ) : null}
      {file.missing && !instructions ? (
        <PaMuted size="xs">{t("settings.files.missing")}</PaMuted>
      ) : null}

      {instructions ? (
        <div className="grid min-w-0 gap-2 rounded-md bg-inset p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <Badge size="xs" tone="slate">
              {t("settings.files.managed.title")}
            </Badge>
            <Button
              aria-expanded={showBlock}
              onClick={() => setShowBlock((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {showBlock
                ? t("settings.files.managed.hide")
                : t("settings.files.managed.show")}
            </Button>
          </div>
          <PaMuted size="xs">
            {instructions.managedPresent
              ? t("settings.files.managed.body")
              : `${t("settings.files.managed.body")} ${t("settings.files.managed.missing")}`}
          </PaMuted>
          {showBlock ? (
            <pre className="m-0 max-h-80 min-w-0 overflow-auto rounded-sm bg-surface px-3 py-2.5 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-ink-muted">
              {instructions.managedBlock}
            </pre>
          ) : null}
        </div>
      ) : null}

      {instructions?.newDefault && !editing ? (
        <Alert
          actions={
            <>
              <Button
                onClick={() => setComparing((value) => !value)}
                size="sm"
                variant="ghost"
              >
                {comparing
                  ? t("settings.files.newDefault.hideCompare")
                  : t("settings.files.newDefault.compare")}
              </Button>
              <Button
                busy={saving}
                disabled={saving || !!file.readOnly}
                onClick={() => void answerDefault(true)}
                size="sm"
                variant="primary"
              >
                {t("settings.files.newDefault.adopt")}
              </Button>
              <Button
                disabled={saving}
                onClick={() => void answerDefault(false)}
                size="sm"
                variant="ghost"
              >
                {t("settings.files.newDefault.keep")}
              </Button>
            </>
          }
          size="compact"
          title={t("settings.files.newDefault.title")}
          tone="info"
        >
          {t("settings.files.newDefault.body")}
        </Alert>
      ) : null}
      {instructions?.newDefault && comparing && !editing ? (
        <FileDiff
          after={instructions.defaultContent}
          before={file.content}
          errorCopy="file"
        />
      ) : null}

      {theirs ? (
        <>
          <Alert
            actions={
              <>
                <Button
                  busy={saving}
                  disabled={saving || overBudget}
                  onClick={() => void save(draft ?? "", theirs.sha256)}
                  size="sm"
                  variant="primary"
                >
                  {t("settings.files.overwrite")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => {
                    setFile(theirs);
                    setTheirs(undefined);
                    setDraft(undefined);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t("settings.files.discard")}
                </Button>
              </>
            }
            size="compact"
            title={t("settings.files.conflictTitle")}
            tone="warning"
          >
            {t("settings.files.conflictBody")}
          </Alert>
          <FileDiff
            after={draft ?? ""}
            before={theirs.content}
            errorCopy="file"
          />
        </>
      ) : null}

      {instructions && !binary ? (
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
          <FieldLabel as="span">{t("settings.files.instructions")}</FieldLabel>
          <span
            className={cn(
              "text-xs",
              overBudget ? "text-error-text" : "text-ink-muted",
            )}
          >
            {t("settings.files.bytes", {
              used: size(bytes),
              max: size(instructions.maxBytes),
            })}
          </span>
        </div>
      ) : null}

      {editing ? (
        <>
          <Textarea
            aria-label={t("settings.files.editLabel", { path })}
            className="min-h-[24rem] font-mono text-xs leading-[1.6]"
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            resize="vertical"
            rows={22}
            spellCheck={false}
            tone="boxed"
            value={draft}
          />
          {overBudget ? (
            <FieldHint tone="error">{t("settings.files.overBudget")}</FieldHint>
          ) : null}
          <ButtonRow>
            <Button
              busy={saving}
              disabled={saving || overBudget || !!theirs}
              onClick={() => void save(draft ?? "", file.sha256)}
              size="sm"
              variant="primary"
            >
              {saving ? t("settings.files.saving") : t("settings.files.save")}
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(undefined);
                setTheirs(undefined);
                setError("");
              }}
              size="sm"
              variant="ghost"
            >
              {t("settings.files.cancel")}
            </Button>
          </ButtonRow>
        </>
      ) : binary ? (
        isInlineImageCandidate(path) ? (
          <WorkspaceImagePreview
            file={{
              workspaceId: workspace.id,
              path,
              content: "",
              truncated: false,
            }}
          />
        ) : (
          <Alert size="compact" title={t("settings.files.readOnly.binary")} />
        )
      ) : file.missing && !instructions ? null : (
        <div className="min-w-0 rounded-md border border-line px-4 py-3">
          <TextFileView content={file.content} path={path} />
        </div>
      )}

      {error ? (
        <ToastFeedback title={t("settings.files.actionFailed")} tone="error">
          {error}
        </ToastFeedback>
      ) : null}

      {binary ? null : (
        <History
          busy={saving || editing}
          file={file}
          onRestore={setRestoring}
        />
      )}

      <Dialog
        busy={saving}
        description={t("settings.files.restoreBody")}
        footer={
          <>
            <Button
              disabled={saving}
              onClick={() => setRestoring(undefined)}
              variant="ghost"
            >
              {t("settings.files.cancel")}
            </Button>
            <Button
              busy={saving}
              disabled={saving}
              onClick={() => restoring && void restore(restoring)}
              variant="primary"
            >
              {t("settings.files.restoreAction")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setRestoring(undefined)}
        open={restoring !== undefined}
        title={t("settings.files.restoreTitle", {
          when: restoring ? clockTime(restoring.at, { date: "short" }) : "",
        })}
      />
      <RenameDialog
        assistantId={assistantId}
        baseSha256={file.sha256}
        onClose={() => setRenaming(false)}
        onRenamed={(to) => {
          setRenaming(false);
          onNotice(t("settings.files.renamed", { path: to }));
          onRenamed(to);
        }}
        open={renaming}
        path={path}
        workspaceId={workspace.id}
      />
    </article>
  );
}
