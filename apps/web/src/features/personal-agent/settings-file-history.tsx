import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import type {
  AssistantFile,
  WorkspaceFileRevision,
} from "@bd777/foundry-protocol";
import { ApiError, moveAssistantFile } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { DividedList } from "../../components/ui/divided-list";
import { TextInput } from "../../components/ui/field";
import { FieldLabel, FormField } from "../../components/ui/form-field";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import { formatBytes } from "../../lib/format";
import { clockTime, fullWhen } from "../../lib/time-format";
import { revisionSource } from "./channel-session-model";
import { PaMuted } from "./pa-muted";

/** Shared parts of the workspace files (DEV-223): versions and renaming. */
const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;
export const size = (bytes: number) =>
  formatBytes(bytes, { kbDigits: 1, trimZeros: true });

export function isConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}

export function folderOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
}

export function History({
  busy,
  file,
  onRestore,
}: {
  busy: boolean;
  file: AssistantFile;
  onRestore: (revision: WorkspaceFileRevision) => void;
}) {
  const { t } = useTranslation("personalAgent");
  return (
    <section className="grid min-w-0 gap-1.5">
      <FieldLabel as="span">{t("settings.files.history")}</FieldLabel>
      {file.revisions.length === 0 ? (
        <PaMuted size="xs">{t("settings.files.historyEmpty")}</PaMuted>
      ) : (
        <DividedList density="compact">
          {file.revisions.map((revision) => (
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
                  `settings.files.revisionSource.${revisionSource(revision.source)}`,
                )}
              </span>
              <span className="text-ink-muted">{size(revision.bytes)}</span>
              {revision.current ? (
                <Badge className="ms-auto" size="xs" tone="online">
                  {t("settings.files.current")}
                </Badge>
              ) : (
                <Button
                  className="ms-auto"
                  disabled={busy || !!file.readOnly}
                  onClick={() => onRestore(revision)}
                  size="sm"
                  variant="ghost"
                >
                  <RotateCcw aria-hidden="true" size={14} />
                  {t("settings.files.restore")}
                </Button>
              )}
            </li>
          ))}
        </DividedList>
      )}
    </section>
  );
}

export function RenameDialog({
  assistantId,
  baseSha256,
  onClose,
  onRenamed,
  open,
  path,
  workspaceId,
}: {
  assistantId?: string;
  baseSha256: string;
  onClose: () => void;
  onRenamed: (path: string) => void;
  open: boolean;
  path: string;
  workspaceId: string;
}) {
  const { t } = useTranslation("personalAgent");
  const [value, setValue] = useState(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setValue(path);
      setError("");
    }
  }, [open, path]);
  const target = value.trim();
  const ready = !!target && target !== path && !target.endsWith("/");
  async function rename(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await moveAssistantFile(assistantId, {
        workspaceId,
        path,
        toPath: target,
        baseSha256,
      });
      onRenamed(target);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {t("settings.files.cancel")}
          </Button>
          <Button
            busy={busy}
            disabled={busy || !ready}
            onClick={() => void rename()}
            variant="primary"
          >
            {t("settings.files.renameAction")}
          </Button>
        </>
      }
      layout="compact"
      onClose={onClose}
      open={open}
      title={t("settings.files.renameTitle", { path })}
    >
      <FormField>
        <span>{t("settings.files.renameLabel")}</span>
        <TextInput
          autoFocus
          className="font-mono"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void rename();
          }}
          spellCheck={false}
          tone="boxed"
          value={value}
        />
      </FormField>
      {error ? (
        <ToastFeedback title={t("settings.files.actionFailed")} tone="error">
          {error}
        </ToastFeedback>
      ) : null}
    </Dialog>
  );
}
