import { toast } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArchiveBlocker } from "@bd777/foundry-protocol";
import {
  archiveChats,
  type ChatArchiveInput,
  type ChatArchiveResult,
} from "../../api";
import { Dialog } from "../../components/ui/dialog";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
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
          ? t("archive.loading")
          : error && !preflight
            ? t("archive.failed")
            : !preflight?.archived.length
              ? t("archive.nothingToArchive")
              : "";
  const commit = async () => {
    if (operationRef.current || operating || disabledReason) return;
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
        <div className="fdy-chat-archive-footer">
          {disabledReason ? (
            <p role="status" className="fdy-chat-archive-disabled-reason">
              {disabledReason}
            </p>
          ) : null}
          <div className="fdy-chat-archive-footer-actions">
            <Button
              ref={cancelRef}
              disabled={operating}
              variant="ghost"
              onClick={onClose}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={operating || Boolean(disabledReason)}
              onClick={() => void commit()}
            >
              {busy
                ? t("archive.busy")
                : t("archive.confirm", {
                    count: preflight?.archived.length ?? 0,
                  })}
            </Button>
          </div>
        </div>
      }
    >
      <div className="fdy-chat-archive-confirmation">
        {preflight ? (
          <section
            className="fdy-chat-archive-included"
            aria-label={t("archive.includedCount", {
              count: preflight.archived.length,
            })}
          >
            <h3>
              {t("archive.includedCount", { count: preflight.archived.length })}
            </h3>
            <ul>
              {preflight.archived.map((id) => (
                <li key={id}>
                  <span title={titles[id] ?? id}>{titles[id] ?? id}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : checking ? (
          <p role="status">{t("archive.loading")}</p>
        ) : null}
        {preflight?.pausedWork.length ? (
          <section className="fdy-chat-archive-paused">
            <h3>{t("archive.pausedWork")}</h3>
            <ul>
              {preflight.pausedWork.map((item) => (
                <li key={item.id} title={item.title}>
                  {item.title}
                </li>
              ))}
            </ul>
            <p>{t("archive.resumeExplicit")}</p>
          </section>
        ) : null}
        {blockers.length ? (
          <Alert tone="warning" title={t("archive.blockers")}>
            <ul className="fdy-chat-archive-blockers">
              {blockers.map((item, index) => {
                const key = archiveBlockerKey(item);
                const receipt = pending.find(
                  (entry) => archiveBlockerKey(entry.blocker) === key,
                )?.receipt;
                const waiting = Boolean(receipt && receipt.state !== "failed");
                return (
                  <li key={`${key}:${index}`}>
                    <div className="fdy-chat-archive-blocker-copy">
                      <strong>{titles[item.id] ?? item.id}</strong>
                      <p>{archiveBlockerReason(item)}</p>
                      {receipt ? (
                        <p className="fdy-chat-archive-control-note">
                          {t(
                            receipt.state === "failed"
                              ? "archive.actionFailed"
                              : "archive.actionPending",
                          )}
                        </p>
                      ) : !canResolveArchiveBlocker(item, input) ? (
                        <p className="fdy-chat-archive-control-note">
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
            <Button
              size="sm"
              disabled={operating || checking}
              onClick={() => void refresh()}
            >
              {t("archive.recheck")}
            </Button>
          </Alert>
        ) : null}
        <details className="fdy-chat-archive-native-details">
          <summary>{t("archive.nativeDetails")}</summary>
          <p>{t("archive.nativeDescription")}</p>
          {preflight?.nativeAlsoHidden?.length ? (
            <>
              <strong>{t("archive.nativeAlsoHidden")}</strong>
              <ul>
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
          <Alert tone="error" title={t("archive.failed")}>
            {error}{" "}
            <Button
              variant="link"
              disabled={operating}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("archive.retry")}
            </Button>
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
