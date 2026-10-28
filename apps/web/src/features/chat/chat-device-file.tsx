import { useEffect, useState } from "react";
import type { DeviceFileRead } from "@bd777/foundry-protocol";
import { Copy, Eye, EyeOff, LoaderCircle, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { readDeviceFile } from "../../api";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import { ChatFileDownload } from "./chat-file-download";
import { formatFileSize, TextFileView } from "./chat-detail-files";
import { FileReadFeedback } from "./chat-file-read-feedback";
import { requestDeviceFile } from "./device-file-request";
import type { ChatDeviceFileItem } from "./chat-types";

/**
 * A file of the chat's device outside the workspace, for the device's
 * owner. It is read when shown. A file that looks like a secret stays
 * masked until Show, Copy sends it to the clipboard without showing it,
 * and it has no download. What was read lives only in this view.
 */
export function DeviceFileDetail({ item }: { item: ChatDeviceFileItem }) {
  const { t } = useTranslation(["chat", "common"]);
  const [file, setFile] = useState<DeviceFileRead>();
  const [error, setError] = useState<unknown>();
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [revealed, setRevealed] = useState<string>();
  const [secretBusy, setSecretBusy] = useState<"show" | "copy">();
  const [secretError, setSecretError] = useState<unknown>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFile(undefined);
    setError(undefined);
    setRevealed(undefined);
    setCopied(false);
    setSecretError(undefined);
    setRetrying(false);
    requestDeviceFile(
      () =>
        readDeviceFile(item.deviceId, item.path, "read", {
          signal: controller.signal,
        }),
      controller.signal,
      () => setRetrying(true),
    )
      .then((read) => {
        if (!controller.signal.aborted) setFile(read);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      });
    return () => controller.abort();
  }, [item.deviceId, item.path, attempt]);

  const reveal = async (purpose: "show" | "copy") => {
    setSecretBusy(purpose);
    setSecretError(undefined);
    setCopied(false);
    try {
      const read = await readDeviceFile(item.deviceId, item.path, "reveal", {
        ...(purpose === "copy" ? { purpose: "copy" as const } : {}),
      });
      if (purpose === "copy") {
        await navigator.clipboard.writeText(read.content ?? "");
        setCopied(true);
      } else {
        setRevealed(read.content ?? "");
      }
    } catch (reason) {
      setSecretError(reason);
    } finally {
      setSecretBusy(undefined);
    }
  };

  const where = t("chat:detail.deviceFile.where", {
    device: item.deviceLabel || t("chat:detail.thisDevice"),
  });
  if (error)
    return (
      <div className="fdy-chat-detail-feedback">
        <FileReadFeedback
          error={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </div>
    );
  if (!file)
    return (
      <div className="fdy-chat-detail-loading">
        <LoaderCircle aria-hidden="true" size={18} />
        {t(
          retrying ? "chat:detail.fileRead.retrying" : "common:states.loading",
        )}
      </div>
    );
  const size = formatFileSize(file.bytes ?? 0);
  return (
    <>
      {file.sensitive ? null : (
        <ChatFileDownload deviceId={item.deviceId} path={item.path} />
      )}
      <article className="fdy-chat-detail-document">
        <p className="fdy-chat-detail-note">
          {where} <code>{item.path}</code>
        </p>
        {file.sensitive ? (
          <div className="fdy-chat-device-secret">
            <p className="fdy-chat-device-secret-title">
              <ShieldAlert aria-hidden="true" size={15} />
              {t("chat:detail.deviceFile.secret", { size })}
            </p>
            {revealed === undefined ? (
              <pre aria-label={t("chat:detail.deviceFile.masked")}>
                ••••••••••••
              </pre>
            ) : (
              <pre>{revealed}</pre>
            )}
            <div className="fdy-chat-device-secret-actions">
              <Button
                disabled={secretBusy !== undefined}
                onClick={() =>
                  revealed === undefined
                    ? void reveal("show")
                    : setRevealed(undefined)
                }
                size="sm"
              >
                {revealed === undefined ? (
                  <Eye aria-hidden="true" size={14} />
                ) : (
                  <EyeOff aria-hidden="true" size={14} />
                )}
                {t(
                  secretBusy === "show"
                    ? "chat:detail.deviceFile.showing"
                    : revealed === undefined
                      ? "chat:detail.deviceFile.show"
                      : "chat:detail.deviceFile.hide",
                )}
              </Button>
              <Button
                disabled={secretBusy !== undefined}
                onClick={() => void reveal("copy")}
                size="sm"
              >
                <Copy aria-hidden="true" size={14} />
                {t(
                  copied
                    ? "chat:detail.deviceFile.copied"
                    : "chat:detail.deviceFile.copy",
                )}
              </Button>
            </div>
            <FieldHint role="status">
              {copied
                ? t("chat:detail.deviceFile.copiedHint")
                : t("chat:detail.deviceFile.secretHint")}
            </FieldHint>
            {secretError ? <FileReadFeedback error={secretError} /> : null}
          </div>
        ) : file.binary ? (
          <p className="fdy-chat-detail-note">
            {t("chat:detail.fileBinaryDownload")}
          </p>
        ) : (
          <>
            {file.truncated ? (
              <p className="fdy-chat-detail-note">
                {t("chat:detail.fileTruncated", {
                  size: formatFileSize(128 * 1024),
                })}
              </p>
            ) : null}
            <TextFileView content={file.content ?? ""} path={item.path} />
          </>
        )}
      </article>
    </>
  );
}
