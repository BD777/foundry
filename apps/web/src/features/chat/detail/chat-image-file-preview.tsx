import { useEffect, useState } from "react";
import type { WorkspaceFileRead } from "@bd777/foundry-protocol";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fetchFileDownload,
  fetchFileDownloadMetadata,
  type FileDownloadMetadata,
} from "../../../api";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { LoadingState } from "../../../components/ui/loading";
import { cn } from "../../../lib/cn";
import { formatBytes } from "../../../lib/format";
import { FileReadFeedback } from "./chat-file-read-feedback";
import { requestDeviceFile } from "./device-file-request";
import {
  decideInlineImage,
  inlineImagePreviewMaxBytes,
} from "./chat-image-preview-model";

type ImagePreviewState =
  | { phase: "loading" }
  | { phase: "ready"; size: number; url: string }
  | { phase: "binary"; size?: number }
  | { phase: "too-large"; size: number }
  | { phase: "error"; error: unknown };

type ImageLoadResult = {
  blob?: Blob;
  decision: ReturnType<typeof decideInlineImage>;
  metadata: FileDownloadMetadata;
};

const checkerboard =
  "[background-image:conic-gradient(var(--fdy-image-checker-a)_25%,var(--fdy-image-checker-b)_0_50%,var(--fdy-image-checker-a)_0_75%,var(--fdy-image-checker-b)_0)] [background-size:16px_16px]";

function fileSize(bytes: number): string {
  return formatBytes(bytes, { kbDigits: 1, trimZeros: true });
}

/** An image in the Workspace file panel, read through the cookie-authenticated API. */
export function WorkspaceImagePreview({ file }: { file: WorkspaceFileRead }) {
  const { t } = useTranslation("chat");
  const [state, setState] = useState<ImagePreviewState>({ phase: "loading" });
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dimensions, setDimensions] = useState<{
    height: number;
    width: number;
  }>();
  const [actualSize, setActualSize] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setState({ phase: "loading" });
    setRetrying(false);
    setDimensions(undefined);
    setActualSize(false);
    setDecodeFailed(false);

    const load = async (): Promise<ImageLoadResult> => {
      const metadata = await fetchFileDownloadMetadata(
        { path: file.path, workspaceId: file.workspaceId },
        controller.signal,
      );
      if (metadata.size === undefined) {
        throw new Error("the file size is unavailable");
      }
      const decision = decideInlineImage(
        file.path,
        metadata.size,
        metadata.contentType,
      );
      if (decision.kind !== "preview") return { decision, metadata };

      const response = await fetchFileDownload(
        { path: file.path, workspaceId: file.workspaceId },
        controller.signal,
      );
      const blob = await response.blob();
      const actualMetadata: FileDownloadMetadata = {
        contentType:
          response.headers.get("Content-Type") ?? metadata.contentType,
        size: blob.size,
      };
      return {
        decision: decideInlineImage(
          file.path,
          blob.size,
          actualMetadata.contentType,
        ),
        metadata: actualMetadata,
        blob,
      };
    };

    void requestDeviceFile(load, controller.signal, () => setRetrying(true))
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.decision.kind === "too-large") {
          setState({ phase: "too-large", size: result.decision.size });
          return;
        }
        if (result.decision.kind === "not-image") {
          setState({ phase: "binary", size: result.metadata.size });
          return;
        }
        if (!result.blob) throw new Error("the image bytes are unavailable");
        objectUrl = URL.createObjectURL(result.blob);
        setState({
          phase: "ready",
          size: result.metadata.size ?? result.blob.size,
          url: objectUrl,
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ phase: "error", error });
      })
      .finally(() => {
        if (!controller.signal.aborted) setRetrying(false);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, file.path, file.workspaceId]);

  if (state.phase === "loading") {
    return (
      <LoadingState
        label={t(
          retrying
            ? "detail.fileRead.retrying"
            : "detail.fileRead.loadingImage",
        )}
        layout="block"
      />
    );
  }
  if (state.phase === "error") {
    return (
      <FileReadFeedback
        error={state.error}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (state.phase === "binary") {
    return (
      <Alert
        size="compact"
        title={t("detail.fileBinary", {
          size: fileSize(state.size ?? 0),
        })}
      />
    );
  }
  if (state.phase === "too-large") {
    return (
      <Alert
        size="compact"
        title={t("detail.fileImageTooLarge", {
          limit: fileSize(inlineImagePreviewMaxBytes),
          size: fileSize(state.size),
        })}
        tone="warning"
      />
    );
  }

  const decoded = dimensions !== undefined && !decodeFailed;
  const size = fileSize(state.size);
  return (
    <figure className="m-0 grid min-w-0 gap-3">
      <figcaption className="flex min-w-0 items-center justify-between gap-3 text-xs text-ink-muted">
        <span className="min-w-0 tabular-nums">
          {dimensions
            ? t("detail.fileImageDimensions", {
                height: dimensions.height,
                size,
                width: dimensions.width,
              })
            : size}
        </span>
      </figcaption>
      <div
        aria-busy={!decoded && !decodeFailed}
        className={cn(
          "max-h-[min(70vh,720px)] min-h-[180px] overflow-auto rounded-lg border border-line",
          checkerboard,
        )}
      >
        <Button
          aria-label={t(
            actualSize ? "detail.fileImageFit" : "detail.fileImageActualSize",
            { name: file.path.split(/[\\/]/).pop() || file.path },
          )}
          aria-pressed={actualSize}
          className={cn(
            "flex min-h-[178px] min-w-full p-4",
            actualSize
              ? "cursor-zoom-out justify-start"
              : "cursor-zoom-in justify-center",
          )}
          onClick={() => setActualSize((value) => !value)}
          title={t(
            actualSize ? "detail.fileImageFit" : "detail.fileImageActualSize",
            { name: file.path.split(/[\\/]/).pop() || file.path },
          )}
          variant="bare"
        >
          <img
            alt={file.path.split(/[\\/]/).pop() || file.path}
            className={cn(
              "block",
              actualSize
                ? "h-auto max-h-none w-auto max-w-none"
                : "h-auto max-w-full",
            )}
            hidden={!decoded}
            onError={() => setDecodeFailed(true)}
            onLoad={(event) =>
              setDimensions({
                height: event.currentTarget.naturalHeight,
                width: event.currentTarget.naturalWidth,
              })
            }
            src={state.url}
          />
        </Button>
      </div>
      {!decoded && !decodeFailed ? (
        <LoadingState
          label={t("detail.fileRead.loadingImage")}
          layout="block"
        />
      ) : null}
      {decodeFailed ? (
        <Alert
          actions={
            <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
              <RotateCcw aria-hidden="true" size={14} />
              {t("detail.fileRead.retry")}
            </Button>
          }
          size="compact"
          title={t("detail.fileImageRenderFailed")}
          tone="error"
        />
      ) : null}
    </figure>
  );
}
