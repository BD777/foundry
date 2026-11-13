import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Pencil, RotateCcw } from "lucide-react";
import type {
  MessageChannelInstructions,
  MessageChannelInstructionsRevision,
  MessageChannelWorkspace,
} from "@bd777/foundry-protocol";
import {
  ApiError,
  getMessageChannelInstructions,
  revertMessageChannelInstructions,
  saveMessageChannelInstructions,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { DividedList } from "../../components/ui/divided-list";
import { Textarea } from "../../components/ui/field";
import { FieldLabel } from "../../components/ui/form-field";
import { Skeleton } from "../../components/ui/loading";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import { formatBytes } from "../../lib/format";
import { foundryIdHref } from "../../lib/in-app-navigation";
import { clockTime, fullWhen } from "../../lib/time-format";
import { revisionSource } from "./channel-session-model";
import { PaMuted } from "./pa-muted";

function isConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}

/**
 * Where a saved channel's sessions run: its workspace (read-only for them),
 * the skills that load there, and its AGENTS.md, the person's instructions
 * for the channel, with its saved versions to restore.
 */
export function ChannelEnvironment({
  assistantId,
  channelId,
  workspace,
  onNotice,
}: {
  assistantId?: string;
  channelId: string;
  workspace?: MessageChannelWorkspace;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  if (!workspace)
    return (
      <div className="grid min-w-0 gap-3 rounded-lg bg-inset p-3.5">
        <PaMuted size="xs">
          {t("settings.channels.environment.pending")}
        </PaMuted>
      </div>
    );
  const href = foundryIdHref(workspace.id);
  return (
    <div className="grid min-w-0 gap-4 rounded-lg bg-inset p-3.5">
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-ink-muted">
          {t("settings.channels.environment.workspace")}
        </dt>
        <dd className="min-w-0">
          {href ? (
            <Button asChild className="text-xs" size="inline" variant="link">
              <AppLink href={href}>
                {workspace.name}
                <ArrowUpRight aria-hidden="true" size={13} />
              </AppLink>
            </Button>
          ) : (
            <span className="text-ink">{workspace.name}</span>
          )}
        </dd>
        <dt className="text-ink-muted">
          {t("settings.channels.environment.computer")}
        </dt>
        <dd className="min-w-0 wrap-anywhere text-ink">
          {workspace.deviceName || workspace.deviceId}
        </dd>
        <dt className="text-ink-muted">
          {t("settings.channels.environment.path")}
        </dt>
        <dd className="min-w-0 font-mono wrap-anywhere text-ink">
          {workspace.path}
        </dd>
        <dt className="text-ink-muted">
          {t("settings.channels.environment.skills")}
        </dt>
        <dd className="min-w-0 text-ink">
          {workspace.skills.length ? (
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {workspace.skills.map((skill) => (
                <li key={skill}>
                  <Badge size="xs" tone="neutral">
                    {skill}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-muted">
              {t("settings.channels.environment.noSkills")}
            </span>
          )}
        </dd>
      </dl>
      <PaMuted size="xs">{t("settings.channels.environment.readOnly")}</PaMuted>
      <InstructionsEditor
        assistantId={assistantId}
        channelId={channelId}
        onNotice={onNotice}
      />
    </div>
  );
}

function InstructionsEditor({
  assistantId,
  channelId,
  onNotice,
}: {
  assistantId?: string;
  channelId: string;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const [instructions, setInstructions] =
    useState<MessageChannelInstructions>();
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reverting, setReverting] =
    useState<MessageChannelInstructionsRevision>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInstructions(
        await getMessageChannelInstructions(assistantId, channelId),
      );
      setLoadError("");
      setPending(false);
    } catch (reason) {
      if (isConflict(reason)) setPending(true);
      else setLoadError(serverErrorText(reason));
    } finally {
      setLoading(false);
    }
  }, [assistantId, channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reload(): Promise<void> {
    setDraft(undefined);
    setConflict(false);
    setError("");
    await load();
  }

  async function save(): Promise<void> {
    if (!instructions || draft === undefined) return;
    setSaving(true);
    setError("");
    try {
      setInstructions(
        await saveMessageChannelInstructions(
          assistantId,
          channelId,
          draft,
          instructions.sha256,
        ),
      );
      setDraft(undefined);
      onNotice(t("settings.channels.environment.saved"));
    } catch (reason) {
      if (isConflict(reason)) setConflict(true);
      else setError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function revert(
    revision: MessageChannelInstructionsRevision,
  ): Promise<void> {
    if (!instructions) return;
    setSaving(true);
    setError("");
    try {
      setInstructions(
        await revertMessageChannelInstructions(
          assistantId,
          channelId,
          revision.id,
          instructions.sha256,
        ),
      );
      setReverting(undefined);
      onNotice(
        t("settings.channels.environment.reverted", {
          when: clockTime(revision.at, { date: "short" }),
        }),
      );
    } catch (reason) {
      setReverting(undefined);
      if (isConflict(reason)) setConflict(true);
      else
        setError(
          `${t("settings.channels.environment.revertFailed")}: ${serverErrorText(reason)}`,
        );
    } finally {
      setSaving(false);
    }
  }

  if (pending)
    return (
      <PaMuted size="xs">{t("settings.channels.environment.pending")}</PaMuted>
    );
  if (!instructions)
    return loadError ? (
      <Alert
        actions={
          <Button
            busy={loading}
            disabled={loading}
            onClick={() => void load()}
            size="sm"
          >
            {t("settings.channels.environment.retry")}
          </Button>
        }
        size="compact"
        title={t("settings.channels.environment.loadFailed")}
        tone="error"
      >
        {loadError}
      </Alert>
    ) : (
      <Skeleton
        className="h-24"
        label={t("settings.channels.environment.loading")}
      />
    );

  const editing = draft !== undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <ButtonRow className="justify-between gap-3">
        <FieldLabel as="span" id={`${ids}-label`}>
          {t("settings.channels.environment.instructions")}
        </FieldLabel>
        {editing ? null : (
          <Button
            disabled={saving}
            onClick={() => {
              setConflict(false);
              setError("");
              setDraft(instructions.content);
            }}
            size="sm"
            variant="ghost"
          >
            <Pencil aria-hidden="true" size={14} />
            {t("settings.channels.environment.edit")}
          </Button>
        )}
      </ButtonRow>
      {conflict ? (
        <Alert
          actions={
            <Button
              busy={loading}
              disabled={loading}
              onClick={() => void reload()}
              size="sm"
            >
              {t("settings.channels.environment.reload")}
            </Button>
          }
          size="compact"
          title={t("settings.channels.environment.conflictTitle")}
          tone="warning"
        >
          {t("settings.channels.environment.conflictBody")}
        </Alert>
      ) : null}
      {editing ? (
        <>
          <Textarea
            aria-label={t("settings.channels.environment.editLabel")}
            className="font-mono"
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            resize="vertical"
            rows={16}
            spellCheck={false}
            tone="boxed"
            value={draft}
          />
          <ButtonRow>
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(undefined);
                setConflict(false);
                setError("");
              }}
              size="sm"
              variant="ghost"
            >
              {t("settings.channels.environment.cancel")}
            </Button>
            <Button
              busy={saving}
              disabled={saving || conflict}
              onClick={() => void save()}
              size="sm"
              variant="primary"
            >
              {saving
                ? t("settings.channels.environment.saving")
                : t("settings.channels.environment.save")}
            </Button>
          </ButtonRow>
        </>
      ) : instructions.missing || !instructions.content.trim() ? (
        <PaMuted size="xs">
          {instructions.missing
            ? t("settings.channels.environment.missing")
            : t("settings.channels.environment.empty")}
        </PaMuted>
      ) : (
        <pre
          aria-labelledby={`${ids}-label`}
          className="m-0 max-h-96 min-w-0 overflow-auto rounded-md bg-surface px-3 py-2.5 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-ink"
        >
          {instructions.content}
        </pre>
      )}
      {error ? (
        <ToastFeedback
          title={t("settings.channels.environment.saveFailed")}
          tone="error"
        >
          {error}
        </ToastFeedback>
      ) : null}
      <div className="grid min-w-0 gap-1.5">
        <FieldLabel as="span">
          {t("settings.channels.environment.history")}
        </FieldLabel>
        {instructions.revisions.length === 0 ? (
          <PaMuted size="xs">
            {t("settings.channels.environment.historyEmpty")}
          </PaMuted>
        ) : (
          <DividedList density="compact">
            {instructions.revisions.map((revision, index) => {
              const current =
                index === 0 &&
                !instructions.missing &&
                revision.sha256 === instructions.sha256;
              return (
                <li
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                  key={revision.id}
                >
                  <time
                    className="text-ink"
                    dateTime={revision.at}
                    title={fullWhen(revision.at)}
                  >
                    {clockTime(revision.at, { date: "short" })}
                  </time>
                  <span className="text-ink-muted">
                    {t(
                      `settings.channels.environment.revisionSource.${revisionSource(revision.source)}`,
                    )}
                  </span>
                  <span className="text-ink-muted">
                    {formatBytes(revision.bytes)}
                  </span>
                  {current ? (
                    <Badge size="xs" tone="online">
                      {t("settings.channels.environment.current")}
                    </Badge>
                  ) : (
                    <Button
                      className="ms-auto"
                      disabled={saving || editing}
                      onClick={() => setReverting(revision)}
                      size="sm"
                      variant="ghost"
                    >
                      <RotateCcw aria-hidden="true" size={14} />
                      {t("settings.channels.environment.revert")}
                    </Button>
                  )}
                </li>
              );
            })}
          </DividedList>
        )}
      </div>
      <Dialog
        busy={saving}
        description={t("settings.channels.environment.revertBody")}
        footer={
          <>
            <Button
              disabled={saving}
              onClick={() => setReverting(undefined)}
              variant="ghost"
            >
              {t("settings.channels.environment.cancel")}
            </Button>
            <Button
              busy={saving}
              disabled={saving}
              onClick={() => reverting && void revert(reverting)}
              variant="primary"
            >
              {t("settings.channels.environment.revertAction")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setReverting(undefined)}
        open={reverting !== undefined}
        title={t("settings.channels.environment.revertTitle", {
          when: reverting ? clockTime(reverting.at, { date: "short" }) : "",
        })}
      />
    </div>
  );
}
