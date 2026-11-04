import { toast } from "../../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArchiveBlocker } from "@bd777/foundry-protocol";
import {
  archiveChats,
  type ChatArchiveInput,
  type ChatArchiveResult,
} from "../../../api";
import { Dialog } from "../../../components/ui/dialog";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { HelpHint } from "../../../components/ui/help-hint";
import { Skeleton } from "../../../components/ui/loading";
import { archiveBlockerReason } from "./chat-archive-reasons";
import {
  archiveBlockerActionLabel,
  archiveBlockerKey,
  canResolveArchiveBlocker,
  checkArchiveBlockerResolution,
  resolveArchiveBlocker,
  type ArchiveBlockerResolution,
} from "./chat-archive-controls";

export function ChatArchiveDialog({
  input,
  titles,
  onClose,
  onArchive,
  returnFocusTo,
}: {
  input: ChatArchiveInput;
  titles: Record<string, string>;
  onClose: () => void;
  onArchive: (expectedChatIds: string[]) => Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const operationRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [preflight, setPreflight] = useState<ChatArchiveResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [resolving, setResolving] = useState("");
  const [pending, setPending] = useState<
    { blocker: ArchiveBlocker; receipt: ArchiveBlockerResolution }[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setChecking(true);
    setError("");
    void archiveChats({ ...input, dryRun: true })
      .then((result) => {
        if (live) setPreflight(result);
      })
      .catch((error) => {
        if (live) setError(String(error.message ?? error));
      })
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [input.workspaceId, input.groupId, input.chatIds?.join("|"), attempt]);
  const blockers = [...(preflight?.blockers ?? [])];
  for (const { blocker } of pending)
    if (
      !blockers.some(
        (item) => archiveBlockerKey(item) === archiveBlockerKey(blocker),
      )
    )
      blockers.push(blocker);
  const operating = busy || Boolean(resolving);
  const disabledReason = pending.some((item) => item.receipt.state === "failed")
    ? t("archive.actionFailed")
    : pending.length
      ? t("archive.disabledPending")
      : blockers.length
        ? t("archive.disabledBlockers")
        : checking
          ? ""
          : error && !preflight
            ? t("archive.failed")
            : !preflight?.archived.length
              ? t("archive.nothingToArchive")
              : "";
  // While the check runs the body shows it (a skeleton); the button waits.
  const blocked = checking || Boolean(disabledReason);
  const commit = async () => {
    if (operationRef.current || operating || blocked) return;
    operationRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onArchive(preflight?.archived ?? []);
      onClose();
    } catch (error) {
      toast({
        id: "chat-archive-error",
        tone: "error",
        title: t("archive.failed"),
        description: String(error instanceof Error ? error.message : error),
      });
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };
  const resolve = async (blocker: ArchiveBlocker) => {
    if (operationRef.current || operating || checking) return;
    operationRef.current = true;
    setResolving(archiveBlockerKey(blocker));
    setError("");
    try {
      const receipt = await resolveArchiveBlocker(blocker, input);
      setPending((previous) => [
        ...previous.filter(
          (item) =>
            archiveBlockerKey(item.blocker) !== archiveBlockerKey(blocker),
        ),
        ...(receipt.state === "verified" ? [] : [{ blocker, receipt }]),
      ]);
      setAttempt((value) => value + 1);
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      operationRef.current = false;
      setResolving("");
    }
  };
  const refresh = async () => {
    if (operationRef.current || operating || checking) return;
    operationRef.current = true;
    setResolving("refresh");
    setError("");
    try {
      const results = await Promise.all(
        pending.map(async (item) => ({
          ...item,
          receipt: await checkArchiveBlockerResolution(
            item.blocker,
            item.receipt,
          ),
        })),
      );
      setPending(results.filter((item) => item.receipt.state !== "verified"));
      setAttempt((value) => value + 1);
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      operationRef.current = false;
      setResolving("");
    }
  };
  return (
    <Dialog
      title={t("archive.confirmTitle")}
      description={t("archive.description")}
      layout="compact"
      onClose={onClose}
      busy={operating}
      initialFocus={cancelRef}
      returnFocusTo={returnFocusTo}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2.5">
          {disabledReason ? (
            <Alert
              className="fdy-chat-archive-disabled-reason min-w-40 flex-1"
              size="compact"
              title={disabledReason}
              tone="warning"
            />
          ) : null}
          <div className="ml-auto flex justify-end gap-2">
            <Button
              ref={cancelRef}
              disabled={operating}
              variant="ghost"
              onClick={onClose}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              busy={busy}
              variant="primary"
              disabled={operating || blocked}
              onClick={() => void commit()}
            >
              {busy
                ? t("archive.busy")
                : checking && !preflight
                  ? t("archive.confirmPending")
                  : t("archive.confirm", {
                      count: preflight?.archived.length ?? 0,
                    })}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid min-w-0 gap-3.5">
        {preflight ? (
          <section
            className="fdy-chat-archive-included min-w-0 overflow-hidden rounded-md shadow-hairline"
            aria-label={t("archive.includedCount", {
              count: preflight.archived.length,
            })}
          >
            <h3 className="border-b border-line-soft px-3 py-[7px] text-xs font-semibold">
              {t("archive.includedCount", { count: preflight.archived.length })}
            </h3>
            <ul className="max-h-[min(10rem,28dvh)] overflow-y-auto py-1">
              {preflight.archived.map((id) => (
                <li className="px-3 py-[5px] text-sm leading-[1.45]" key={id}>
                  <span className="block truncate" title={titles[id] ?? id}>
                    {titles[id] ?? id}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : checking ? (
          <Skeleton label={t("archive.loading")} rows={3} variant="rows" />
        ) : null}
        {preflight?.pausedWork.length ? (
          <section className="fdy-chat-archive-paused min-w-0 text-xs">
            <h3 className="mb-[5px] flex items-center gap-1.5 text-xs font-semibold">
              {t("archive.pausedWork")}
              <HelpHint label={t("archive.pausedWorkHelp")}>
                {t("archive.resumeExplicit")}
              </HelpHint>
            </h3>
            <ul className="max-h-20 overflow-y-auto pl-[18px]">
              {preflight.pausedWork.map((item) => (
                <li className="truncate" key={item.id} title={item.title}>
                  {item.title}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {blockers.length ? (
          <Alert
            actions={
              <Button
                size="sm"
                disabled={operating || checking}
                onClick={() => void refresh()}
              >
                {t("archive.recheck")}
              </Button>
            }
            tone="warning"
            title={t("archive.blockers")}
          >
            <ul className="mt-1 grid gap-3">
              {blockers.map((item, index) => {
                const key = archiveBlockerKey(item);
                const receipt = pending.find(
                  (entry) => archiveBlockerKey(entry.blocker) === key,
                )?.receipt;
                const waiting = Boolean(receipt && receipt.state !== "failed");
                return (
                  <li
                    className="flex items-start gap-2.5"
                    key={`${key}:${index}`}
                  >
                    <div className="min-w-0 flex-1">
                      <strong className="block text-xs wrap-anywhere">
                        {titles[item.id] ?? item.id}
                      </strong>
                      <p className="text-xs">{archiveBlockerReason(item)}</p>
                      {receipt ? (
                        <p className="mt-1 text-xs">
                          {t(
                            receipt.state === "failed"
                              ? "archive.actionFailed"
                              : "archive.actionPending",
                          )}
                        </p>
                      ) : !canResolveArchiveBlocker(item, input) ? (
                        <p className="mt-1 text-xs">
                          {t("archive.actionUnavailable")}
                        </p>
                      ) : null}
                    </div>
                    {canResolveArchiveBlocker(item, input) ? (
                      <Button
                        size="sm"
                        disabled={operating || checking || waiting}
                        onClick={() => void resolve(item)}
                      >
                        {resolving === key
                          ? t("archive.actionBusy")
                          : archiveBlockerActionLabel(item)}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Alert>
        ) : null}
        <details className="fdy-chat-archive-native-details text-xs text-ink-muted">
          <summary className="cursor-pointer">
            {t("archive.nativeDetails")}
          </summary>
          <p className="mt-1.5 text-xs leading-normal">
            {t("archive.nativeDescription")}
          </p>
          {preflight?.nativeAlsoHidden?.length ? (
            <>
              <strong>{t("archive.nativeAlsoHidden")}</strong>
              <ul className="mt-1.5 pl-[18px]">
                {preflight.nativeAlsoHidden.map((item) => (
                  <li key={item.id} title={item.title || item.id}>
                    {item.title || item.id}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </details>
        {error ? (
          <Alert
            actions={
              <Button
                size="sm"
                disabled={operating}
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t("archive.retry")}
              </Button>
            }
            tone="error"
            title={t("archive.failed")}
          >
            {error}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
