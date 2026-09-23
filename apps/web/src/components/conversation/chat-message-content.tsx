import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  Search,
  ShieldAlert,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import type { ChatAttachment } from "@foundry/protocol";
import { localImageUrl } from "../../api";
import { Button } from "../ui/button";
import {
  compactProcessToolDetail,
  processDisplayRows,
  processDisplaySummaryTitle,
  type ProcessDisplayRow,
  type ProcessDisplayItem,
} from "./chat-process-display";

const streamingTextAnimation = {
  animation: "fadeIn" as const,
  duration: 140,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  maxBacklogMs: 120,
  sep: "word" as const,
  stagger: 12,
};

export interface ParsedImageTag {
  alt: string;
  path: string;
}

type MarkdownSegment =
  { kind: "image"; image: ParsedImageTag } | { kind: "text"; text: string };

interface ProcessDisplaySummary {
  detail: string;
  iconTitle: string;
  title: string;
}

function parseImageTagAttributes(
  attributes: string,
): ParsedImageTag | undefined {
  const pathMatch = attributes.match(
    /\bpath=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
  );
  const path = pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3];
  if (!path) {
    return undefined;
  }
  const nameMatch = attributes.match(
    /\bname=(?:"([^"]+)"|'([^']+)'|(\[[^\]]+]|[^\s>]+))/i,
  );
  const alt = (
    nameMatch?.[1] ??
    nameMatch?.[2] ??
    nameMatch?.[3] ??
    "Attached image"
  ).trim();
  return { alt, path };
}

function splitMarkdownImageTags(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const imageTagPattern = /<image\b([\s\S]*?)>\s*(?:<\/image>)?/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(imageTagPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, index) });
    }
    const image = parseImageTagAttributes(match[1] ?? "");
    if (image) {
      segments.push({ kind: "image", image });
    } else {
      segments.push({ kind: "text", text: match[0] });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function MarkdownImage({
  image,
  onPreview,
}: {
  image: ParsedImageTag;
  onPreview?: (image: ParsedImageTag) => void;
}) {
  const src = localImageUrl(image.path);
  return (
    <figure className="fdy-markdown-image">
      <Button
        aria-label={`Preview ${image.alt}`}
        onClick={() => onPreview?.(image)}
        variant="ghost"
      >
        <img alt={image.alt} loading="lazy" src={src} />
      </Button>
      <figcaption>{image.alt}</figcaption>
    </figure>
  );
}

const markdownComponents: Components = {
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

function MarkdownText({
  children,
  streaming,
}: {
  children: string;
  streaming: boolean;
}) {
  return (
    <Streamdown
      animated={streamingTextAnimation}
      components={markdownComponents}
      isAnimating={streaming}
      mode="streaming"
      parseIncompleteMarkdown={streaming}
      skipHtml
    >
      {children}
    </Streamdown>
  );
}

function preserveLiteralListMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(\s*)(\d+)\.\s+/, "$1$2\\. ")
        .replace(/^(\s*)[-*+]\s+/, "$1\\- "),
    )
    .join("\n");
}

export function MarkdownContent({
  children,
  onImagePreview,
  preserveLists = false,
  streaming = false,
}: {
  children: ReactNode;
  onImagePreview?: (image: ParsedImageTag) => void;
  preserveLists?: boolean;
  streaming?: boolean;
}) {
  if (typeof children !== "string") {
    return <>{children}</>;
  }
  const content = preserveLists
    ? preserveLiteralListMarkers(children)
    : children;
  return (
    <>
      {splitMarkdownImageTags(content).map((segment, index) =>
        segment.kind === "image" ? (
          <MarkdownImage
            image={segment.image}
            key={`image-${index}`}
            onPreview={onImagePreview}
          />
        ) : segment.text.trim() ? (
          <MarkdownText key={`text-${index}`} streaming={streaming}>
            {segment.text}
          </MarkdownText>
        ) : null,
      )}
    </>
  );
}

function ProcessItemIcon({ title }: { title: string }) {
  const normalized = title.toLowerCase();
  if (normalized.includes("搜索") || normalized.includes("search")) {
    return <Search size={15} />;
  }
  if (
    normalized.includes("读取") ||
    normalized.includes("加载") ||
    normalized.includes("loaded") ||
    normalized.includes("file") ||
    normalized.includes("skill") ||
    normalized.includes("workspace") ||
    normalized.includes("上下文")
  ) {
    return <FileText size={15} />;
  }
  if (
    normalized.includes("sdk") ||
    normalized.includes("cli") ||
    normalized.includes("profile") ||
    normalized.includes("命令") ||
    normalized.includes("工具")
  ) {
    return <Terminal size={15} />;
  }
  if (normalized.includes("权限") || normalized.includes("permission")) {
    return <ShieldAlert size={15} />;
  }
  return <Zap size={15} />;
}

function processDisplaySummary(
  processItems: ProcessDisplayRow[],
  title: ReactNode,
  streaming: boolean,
): ProcessDisplaySummary {
  const fallbackTitle = typeof title === "string" ? title : "已处理";
  const activeItem = processItems?.[processItems.length - 1];
  if (activeItem) {
    return {
      detail: activeItem.snippet,
      iconTitle: activeItem.title,
      title: processDisplaySummaryTitle(processItems, fallbackTitle, streaming),
    };
  }
  return {
    detail: "",
    iconTitle: fallbackTitle,
    title: processDisplaySummaryTitle([], fallbackTitle, streaming),
  };
}

function CompactToolDetailCard({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="fdy-chat-process-tool-detail">
      <span>{label}</span>
      <Button
        aria-label={copied ? "Copied tool detail" : "Copy tool detail"}
        className="fdy-chat-process-tool-copy"
        data-copied={copied ? "true" : "false"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          } catch {
            setCopied(false);
          }
        }}
        size="icon"
        variant="ghost"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
      <pre>{content}</pre>
    </div>
  );
}

function ProcessDisclosureItem({
  active,
  item,
  onImagePreview,
}: {
  active: boolean;
  item: ProcessDisplayRow;
  onImagePreview?: (image: ParsedImageTag) => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.detail);
  const compactToolDetail = compactProcessToolDetail(item);
  const summary = (
    <>
      <ProcessItemIcon title={item.title} />
      <span className="fdy-chat-process-item-copy">
        <strong>{item.title}</strong>
        {item.snippet ? <span>{item.snippet}</span> : null}
      </span>
      {expandable ? <ChevronRight size={14} /> : null}
    </>
  );

  return (
    <div
      className="fdy-chat-process-item"
      data-active={active ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      {expandable ? (
        <Button
          aria-expanded={open}
          className="fdy-chat-process-item-trigger"
          onClick={() => setOpen((value) => !value)}
          variant="ghost"
        >
          {summary}
        </Button>
      ) : (
        <div className="fdy-chat-process-item-trigger">{summary}</div>
      )}
      {open ? (
        <div className="fdy-chat-process-item-detail">
          {compactToolDetail ? (
            <CompactToolDetailCard
              content={compactToolDetail.content}
              label={compactToolDetail.label}
            />
          ) : (
            <MarkdownContent onImagePreview={onImagePreview} streaming={active}>
              {item.detail}
            </MarkdownContent>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  const mb = size / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function AttachmentPreviewItem({
  attachment,
  onPreview,
  onRemove,
  removable = false,
}: {
  attachment: ChatAttachment;
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable?: boolean;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size);
  return (
    <div className="fdy-chat-attachment" data-kind={attachment.kind}>
      {attachment.kind === "image" ? (
        <Button
          aria-label={`Preview ${attachment.name}`}
          className="fdy-chat-attachment-thumb"
          onClick={() =>
            onPreview?.({ alt: attachment.name, path: attachment.path })
          }
          variant="ghost"
        >
          <img
            alt={attachment.name}
            loading="lazy"
            src={localImageUrl(attachment.path)}
          />
        </Button>
      ) : (
        <span className="fdy-chat-attachment-file-icon">
          <FileText size={17} />
        </span>
      )}
      <span className="fdy-chat-attachment-copy">
        <strong>{attachment.name}</strong>
        {sizeLabel ? <em>{sizeLabel}</em> : null}
      </span>
      {removable ? (
        <Button
          aria-label={`Remove ${attachment.name}`}
          className="fdy-chat-attachment-remove"
          onClick={() => onRemove?.(attachment.id)}
          size="icon"
          variant="ghost"
        >
          <X size={14} />
        </Button>
      ) : null}
    </div>
  );
}

export function AttachmentList({
  attachments,
  onPreview,
  onRemove,
  removable = false,
}: {
  attachments: ChatAttachment[];
  onPreview?: (image: ParsedImageTag) => void;
  onRemove?: (id: string) => void;
  removable?: boolean;
}) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="fdy-chat-attachments">
      {attachments.map((attachment) => (
        <AttachmentPreviewItem
          attachment={attachment}
          key={attachment.id}
          onPreview={onPreview}
          onRemove={onRemove}
          removable={removable}
        />
      ))}
    </div>
  );
}

export function CopyButton({
  always = false,
  text,
}: {
  always?: boolean;
  text: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      aria-label={copied ? "Copied" : "Copy message"}
      className="fdy-chat-copy-button"
      data-always={always ? "true" : "false"}
      data-copied={copied ? "true" : "false"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
      size="icon"
      variant="ghost"
    >
      <Copy size={14} />
    </Button>
  );
}

export function ProcessDisclosure({
  items,
  onImagePreview,
  streaming = false,
  text,
  title,
}: {
  items?: ProcessDisplayItem[];
  onImagePreview?: (image: ParsedImageTag) => void;
  streaming?: boolean;
  text: ReactNode;
  title: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const processItems = processDisplayRows(items, streaming);
  const summary = processDisplaySummary(processItems, title, streaming);

  return (
    <section
      className="fdy-chat-process"
      data-live={streaming ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      <Button
        aria-expanded={open}
        className="fdy-chat-process-trigger"
        onClick={() => setOpen((value) => !value)}
        variant="ghost"
      >
        {streaming ? (
          <span className="fdy-chat-process-spinner" aria-hidden="true" />
        ) : (
          <ProcessItemIcon title={summary.iconTitle} />
        )}
        <span className="fdy-chat-process-trigger-copy">
          <strong>{summary.title}</strong>
          {streaming && summary.detail ? (
            <span className="fdy-chat-process-trigger-detail">
              {summary.detail}
            </span>
          ) : null}
        </span>
        <ChevronRight size={15} />
      </Button>
      {open ? (
        <div className="fdy-chat-process-body">
          <div className="fdy-chat-process-body-inner fdy-markdown">
            {processItems.length > 0 ? (
              <div className="fdy-chat-process-items">
                {processItems.map((item, index) => (
                  <ProcessDisclosureItem
                    active={
                      streaming &&
                      (item.status
                        ? item.status === "running"
                        : index === processItems.length - 1)
                    }
                    item={item}
                    key={item.id ?? `${item.title}-${index}`}
                    onImagePreview={onImagePreview}
                  />
                ))}
              </div>
            ) : (
              <MarkdownContent
                onImagePreview={onImagePreview}
                streaming={streaming}
              >
                {text}
              </MarkdownContent>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ToolCallItem({
  streaming = false,
  text,
  title,
}: {
  streaming?: boolean;
  text: ReactNode;
  title: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Extract a one-line summary snippet from the text content.
  const snippet = useMemo(() => {
    if (typeof text !== "string") {
      return "";
    }
    const firstLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ?? "";
  }, [text]);

  return (
    <section
      className="fdy-chat-tool-call"
      data-active={streaming ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      <Button
        className="fdy-chat-tool-call-summary"
        onClick={() => setOpen((value) => !value)}
        variant="ghost"
      >
        <span className="fdy-chat-tool-call-icon">
          {streaming ? (
            <span className="fdy-chat-tool-call-spinner" aria-hidden="true" />
          ) : (
            <FileText size={14} />
          )}
        </span>
        <span className="fdy-chat-tool-call-title">
          <strong>{title ?? "Context"}</strong>
          {snippet ? (
            <span className="fdy-chat-tool-call-snippet">{snippet}</span>
          ) : null}
        </span>
        <ChevronRight className="fdy-chat-tool-call-chevron" size={15} />
      </Button>
      {open ? <pre>{text}</pre> : null}
    </section>
  );
}

export function ImagePreviewOverlay({
  image,
  onClose,
}: {
  image: ParsedImageTag;
  onClose: () => void;
}) {
  const src = localImageUrl(image.path);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      aria-label="Image preview"
      aria-modal="true"
      className="fdy-image-preview"
      role="dialog"
    >
      <Button
        aria-label="Close image preview"
        className="fdy-image-preview-backdrop"
        onClick={onClose}
        variant="ghost"
      />
      <div className="fdy-image-preview-panel">
        <div className="fdy-image-preview-topbar">
          <span>{image.alt}</span>
          <Button
            aria-label="Close image preview"
            className="fdy-image-preview-close"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X size={18} />
          </Button>
        </div>
        <img alt={image.alt} src={src} />
      </div>
    </div>
  );
}
