import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { localImageUrl } from "../../api";
import { apiFetch } from "../../api/http";
import { formatBytes } from "../../lib/format";
import {
  readResponseBlob,
  type ReadProgress,
} from "../../lib/read-response-blob";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import "./local-image.css";

type ImageFailure = "offline" | "slow" | "missing" | "unavailable";
type ImageState =
  | { phase: "loading" | "retrying" }
  | { phase: "decoding" | "ready"; src: string }
  | { phase: "error"; reason: ImageFailure };
function failureReason(status: number): ImageFailure {
  if (status === 409) return "offline";
  if (status === 504) return "slow";
  if (status === 404) return "missing";
  return "unavailable";
}
/** Inline derivatives arrive before the original, which is read only on zoom. */
export function LocalImage({
  path,
  alt,
  onPreview,
  presentation = "inline",
}: {
  path: string;
  alt: string;
  onPreview?: () => void;
  presentation?: "inline" | "overlay";
}) {
  const { t } = useTranslation("conversation");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ImageState>({ phase: "loading" });
  const [placeholder, setPlaceholder] = useState<string>();
  const [placeholderReady, setPlaceholderReady] = useState(false);
  const [progress, setProgress] = useState<ReadProgress>({ received: 0 });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined,
      placeholderUrl: string | undefined,
      retryTimer: ReturnType<typeof setTimeout> | undefined;
    setPlaceholder(undefined);
    setPlaceholderReady(false);
    setProgress({ received: 0 });
    const source = localImageUrl(path);
    const placeholderWork =
      presentation === "inline"
        ? (async () => {
            try {
              const response = await apiFetch(`${source}&variant=placeholder`, {
                signal: controller.signal,
              });
              if (response.ok) {
                const blob = await response.blob();
                if (controller.signal.aborted) return;
                placeholderUrl = URL.createObjectURL(blob);
                setPlaceholder(placeholderUrl);
              }
            } catch {
              /* A placeholder failure never prevents the actual preview. */
            }
          })()
        : Promise.resolve();
    let placeholderWait: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setState({ phase: "loading" });
      await Promise.race([
        placeholderWork,
        new Promise<void>((resolve) => {
          placeholderWait = setTimeout(resolve, 400);
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
      ]);
      clearTimeout(placeholderWait);
      if (controller.signal.aborted) return;
      for (let retry = 0; retry < 2; retry++) {
        let reason: ImageFailure = "unavailable",
          transient = true;
        try {
          setProgress({ received: 0 });
          const fresh = attempt > 0 || retry > 0;
          const variant = presentation === "inline" ? "&variant=preview" : "";
          const response = await apiFetch(
            `${source}${variant}${fresh ? "&refresh=1" : ""}`,
            { signal: controller.signal, cache: fresh ? "reload" : "default" },
          );
          if (response.ok) {
            const blob = await readResponseBlob(
              response,
              controller.signal,
              setProgress,
            );
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob);
            setState({ phase: "decoding", src: objectUrl });
            return;
          }
          reason = failureReason(response.status);
          transient = response.status === 409 || response.status >= 500;
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        if (retry === 0 && transient) {
          setState({ phase: "retrying" });
          setProgress({ received: 0 });
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, 1000);
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          if (controller.signal.aborted) return;
        } else {
          setState({ phase: "error", reason });
          return;
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
      clearTimeout(placeholderWait);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (placeholderUrl) URL.revokeObjectURL(placeholderUrl);
    };
  }, [path, attempt, presentation]);
  const image =
    "src" in state ? (
      <img
        alt={alt}
        className="fdy-local-image-content"
        hidden={state.phase !== "ready"}
        onLoad={() => setState({ phase: "ready", src: state.src })}
        onError={() => setState({ phase: "error", reason: "unavailable" })}
        src={state.src}
      />
    ) : null;
  const download = () => {
    if (!("src" in state) || state.phase !== "ready") return;
    const link = document.createElement("a");
    link.href = state.src;
    link.download = path.split(/[\\/]/).pop() || "image";
    document.body.append(link);
    link.click();
    link.remove();
  };
  const status =
    progress.received > 0
      ? t(progress.total ? "image.progress" : "image.progressUnknown", {
          received: formatBytes(progress.received),
          total: formatBytes(progress.total || 0),
        })
      : t(
          state.phase === "retrying"
            ? "image.retrying"
            : presentation === "overlay"
              ? "image.loadingOriginal"
              : "image.loading",
        );
  return (
    <div
      className="fdy-local-image"
      data-presentation={presentation}
      aria-busy={state.phase !== "ready" && state.phase !== "error"}
    >
      {placeholder && state.phase !== "ready" && state.phase !== "error" ? (
        <img
          alt=""
          aria-hidden="true"
          className="fdy-local-image-placeholder"
          hidden={!placeholderReady}
          onLoad={() => setPlaceholderReady(true)}
          src={placeholder}
          onError={() => setPlaceholder(undefined)}
        />
      ) : null}
      {state.phase === "error" ? (
        <Alert size="compact" title={t("image.failed")} tone="error">
          <p className="fdy-local-image-reason">{t(`image.${state.reason}`)}</p>
          <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
            {t("image.retry")}
          </Button>
        </Alert>
      ) : state.phase !== "ready" ? (
        <p className="fdy-local-image-loading" role="status">
          {status}
        </p>
      ) : null}
      {image && onPreview ? (
        <Button
          aria-label={t("image.preview", { name: alt })}
          className="fdy-local-image-preview"
          hidden={state.phase !== "ready"}
          onClick={onPreview}
          variant="bare"
        >
          {image}
        </Button>
      ) : (
        image
      )}
      {state.phase === "ready" && presentation === "inline" && onPreview ? (
        <p className="fdy-local-image-caption">{t("image.previewHint")}</p>
      ) : null}
      {presentation === "overlay" ? (
        <Button disabled={state.phase !== "ready"} onClick={download} size="sm">
          <Download aria-hidden="true" size={14} />
          {t("image.downloadOriginal")}
        </Button>
      ) : null}
    </div>
  );
}
