import { Check, Copy, Eye, ImageDown, Images } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCopied } from "../../lib/use-copied";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { MarkdownContent } from "./markdown-content";
import type {
  ConversationFileReference,
  ParsedImageTag,
} from "./conversation-types";

export type AnswerImageRenderer = (
  node: HTMLElement,
  backgroundColor: string,
) => Promise<Blob>;

interface AnswerMarkdownProps {
  markdown: string;
  deviceFiles?: boolean;
  fileReferences?: ConversationFileReference[];
  fileRoot?: string;
  onImagePreview?: (image: ParsedImageTag) => void;
  onOpenFileReference?: (reference: ConversationFileReference) => void;
}

function waitForDomState(
  node: HTMLElement,
  ready: () => boolean,
): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(node, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });
}

async function waitForPreviewAssets(node: HTMLElement): Promise<void> {
  const imagesSettled = waitForDomState(
    node,
    () => !node.querySelector('[data-image-state="loading"]'),
  );
  const diagramsSettled = waitForDomState(node, () =>
    [...node.querySelectorAll('[data-streamdown="mermaid-block"]')].every(
      (block) =>
        block.querySelector("svg") ||
        block.querySelector('[data-mermaid-error="true"]'),
    ),
  );
  await Promise.all([imagesSettled, diagramsSettled, document.fonts?.ready]);

  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => resolve()),
    ),
  );
}

function svgDataUrl(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(clone),
  )}`;
}

/** Lazily load the exporter so it stays out of the initial chat bundle. */
export async function renderAnswerImage(
  node: HTMLElement,
  backgroundColor: string,
): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  const diagrams = [
    ...node.querySelectorAll<SVGSVGElement>(
      '[data-streamdown="mermaid-block"] svg',
    ),
  ].map((svg) => {
    const box = svg.getBoundingClientRect();
    return {
      height: Math.max(1, Math.ceil(box.height)),
      src: svgDataUrl(svg),
      width: Math.max(1, Math.ceil(box.width)),
    };
  });
  let diagramIndex = 0;
  return domToBlob(node, {
    backgroundColor,
    scale: 2,
    type: "image/png",
    features: { fixSvgXmlDecode: true },
    onCloneEachNode(cloned) {
      if (
        !(cloned instanceof SVGSVGElement) ||
        !cloned.closest('[data-streamdown="mermaid-block"]')
      )
        return;
      const diagram = diagrams[diagramIndex++];
      if (!diagram) return;
      const image = cloned.ownerDocument.createElement("img");
      image.alt = "";
      image.src = diagram.src;
      image.style.display = "block";
      image.style.height = `${diagram.height}px`;
      image.style.width = `${diagram.width}px`;
      cloned.replaceWith(image);
    },
  });
}

function downloadImage(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "answer.png";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function PreviewAction({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "aria-label" | "children">) {
  return (
    <Tooltip content={label}>
      <Button aria-label={label} size="icon" variant="ghost" {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * The full answer in a reading-sized dialog. The hidden export surface uses
 * the same Markdown pipeline at a fixed 720px text column, without interactive
 * controls or table height limits, so the PNG contains the whole answer.
 */
export function AnswerPreviewDialog({
  onClose,
  renderImage = renderAnswerImage,
  ...answer
}: AnswerMarkdownProps & {
  onClose: () => void;
  renderImage?: AnswerImageRenderer;
}) {
  const { t } = useTranslation("conversation");
  const exportRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopied(1200);
  const [busy, setBusy] = useState<"copy-image" | "download-image" | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const copiedMarkdown = copied("markdown");

  async function capture(): Promise<Blob> {
    const node = exportRef.current;
    if (!node) throw new Error("The answer export surface is unavailable.");
    setExporting(true);
    try {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        ),
      );
      await waitForPreviewAssets(node);
      const backgroundColor = window.getComputedStyle(node).backgroundColor;
      const blob = await renderImage(node, backgroundColor);
      if (blob.type !== "image/png") throw new Error("Expected a PNG export.");
      return blob;
    } finally {
      setExporting(false);
    }
  }

  async function copyImage(): Promise<void> {
    if (busy) return;
    setBusy("copy-image");
    try {
      const blob = await capture();
      try {
        if (
          !navigator.clipboard?.write ||
          typeof globalThis.ClipboardItem === "undefined"
        )
          throw new Error("Image clipboard writing is unavailable.");
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        toast({
          tone: "success",
          title: t("message.answerImageCopied"),
        });
      } catch {
        downloadImage(blob);
        toast({
          tone: "warning",
          title: t("message.answerImageDownloadedInstead"),
        });
      }
    } catch {
      toast({ tone: "error", title: t("message.answerImageFailed") });
    } finally {
      setBusy(null);
    }
  }

  async function download(): Promise<void> {
    if (busy) return;
    setBusy("download-image");
    try {
      downloadImage(await capture());
      toast({ tone: "success", title: t("message.answerImageDownloaded") });
    } catch {
      toast({ tone: "error", title: t("message.answerImageFailed") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Dialog
        headerActions={
          <>
            <PreviewAction
              disabled={busy !== null}
              label={t("message.copyAnswerMarkdown")}
              onClick={() => void copy(answer.markdown, "markdown")}
            >
              {copiedMarkdown ? <Check size={16} /> : <Copy size={16} />}
            </PreviewAction>
            <PreviewAction
              busy={busy === "copy-image"}
              disabled={busy !== null}
              label={t("message.copyAnswerImage")}
              onClick={() => void copyImage()}
            >
              <Images size={16} />
            </PreviewAction>
            <PreviewAction
              busy={busy === "download-image"}
              disabled={busy !== null}
              label={t("message.downloadAnswerImage")}
              onClick={() => void download()}
            >
              <ImageDown size={16} />
            </PreviewAction>
          </>
        }
        onClose={onClose}
        open
        size="preview"
        title={t("message.answerPreview")}
      >
        <div className="mx-auto w-full max-w-[720px]">
          <MarkdownContent
            deviceFiles={answer.deviceFiles}
            fileReferences={answer.fileReferences}
            fileRoot={answer.fileRoot}
            imageFallback="alt"
            onImagePreview={answer.onImagePreview}
            onOpenFileReference={answer.onOpenFileReference}
          >
            {answer.markdown}
          </MarkdownContent>
        </div>
      </Dialog>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 w-[816px] bg-surface text-ink"
        data-answer-preview-export="true"
        ref={exportRef}
      >
        <div
          className={
            exporting
              ? "p-12"
              : "pointer-events-none origin-top-left scale-[0.1] p-12 opacity-0"
          }
        >
          <MarkdownContent
            controls={false}
            deviceFiles={answer.deviceFiles}
            fileReferences={answer.fileReferences}
            fileRoot={answer.fileRoot}
            onImagePreview={answer.onImagePreview}
            onOpenFileReference={answer.onOpenFileReference}
            tableMaxHeight={0}
          >
            {answer.markdown}
          </MarkdownContent>
        </div>
      </div>
    </>
  );
}

export function AnswerPreviewButton({
  className,
  ...answer
}: AnswerMarkdownProps & { className?: string }) {
  const { t } = useTranslation("conversation");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content={t("message.previewAnswer")}>
        <Button
          aria-label={t("message.previewAnswer")}
          className={className}
          onClick={() => setOpen(true)}
          size="icon"
          variant="ghost"
        >
          <Eye size={14} />
        </Button>
      </Tooltip>
      {open ? (
        <AnswerPreviewDialog {...answer} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
