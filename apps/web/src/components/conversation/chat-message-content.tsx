import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  Search,
  ShieldAlert,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import remarkBreaks from "remark-breaks";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { localImageUrl } from "../../api";
import { i18n } from "../../i18n";
import {
  processLabelKey,
  type ProcessLabelKey,
} from "../../lib/process-labels";
import { Button } from "../ui/button";
import {
  compactProcessToolDetail,
  processDisplayRows,
  processDisplaySummaryTitle,
  type ProcessDisplayRow,
  type ProcessDisplayItem,
} from "./chat-process-display";
import { formatDuration, stepUsageSummary, stepUsageTitle } from "./turn-usage";
import { ProcessElapsed } from "./process-elapsed";
import type {
  ConversationFileReference,
  StepUsage,
} from "./conversation-types";

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
  iconLabelKey?: ProcessLabelKey;
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
    i18n.t("conversation:message.attachedImage")
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

/** A hast node, as far as marking links needs. */
interface MarkdownTreeNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTreeNode[];
}

/** A target with no scheme or root: `docs/plan.md`, `./a`, `../b`, `?q`. */
function isDocumentRelative(href: string): boolean {
  return href.trim() !== "" && !/^([a-z][a-z\d+.-]*:|[/#\\])/i.test(href);
}

// rehype-harden resolves links against a base and rewrites them, so the
// authored target of a document-relative link is recorded before it runs.
function markRelativeLinks() {
  return (tree: MarkdownTreeNode) => {
    const visit = (node: MarkdownTreeNode) => {
      const href = node.properties?.href;
      if (
        node.tagName === "a" &&
        typeof href === "string" &&
        isDocumentRelative(href)
      )
        node.properties!.dataRelativeHref = href;
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// Streamdown's own plugins in order. Harden blocks a relative link it cannot
// resolve, so it gets a base; that base never reaches the page because a
// relative link renders from its recorded target. Unsafe schemes stay blocked.
const markdownRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> =
  Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) => {
    if (name !== "harden" || !Array.isArray(plugin)) return [plugin];
    const [harden, options] = plugin;
    return [
      markRelativeLinks,
      [harden, { ...options, defaultOrigin: "https://relative.invalid" }],
    ];
  });

function relativeLinkTarget(node: ExtraProps["node"]): string | undefined {
  const target = node?.properties.dataRelativeHref;
  return typeof target === "string" ? target : undefined;
}

/**
 * A link opens in a new tab. A relative one has no page here, so it stays
 * text titled with its target instead of sending the app to a broken route.
 */
function MarkdownLink({
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const relative = relativeLinkTarget(node);
  if (relative !== undefined) return <span title={relative}>{children}</span>;
  return (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  // Plain lists: `.fdy-markdown` owns their markers and vertical rhythm.
  ol: "ol",
  ul: "ul",
  li: "li",
};

/** Plain text of a rendered Markdown node (a code span or a link label). */
function nodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  return Array.isArray(children) ? children.map(nodeText).join("") : "";
}

/** Plain text of a Markdown syntax node, e.g. a link's label. */
function syntaxText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: string; value?: unknown; children?: unknown };
  if (value.type === "text" && typeof value.value === "string")
    return value.value;
  return Array.isArray(value.children)
    ? value.children.map(syntaxText).join("")
    : "";
}

function decodedHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** A file or folder an answer names, opened in the chat's side panel. */
function FileReferenceButton({
  children,
  code,
  onOpen,
  reference,
}: {
  children: ReactNode;
  code: boolean;
  onOpen: (reference: ConversationFileReference) => void;
  reference: ConversationFileReference;
}) {
  const { t } = useTranslation("conversation");
  return (
    <Button
      className="fdy-chat-file-reference"
      onClick={() => onOpen(reference)}
      size="inline"
      title={t(
        reference.kind === "dir" ? "message.showFolder" : "message.openFile",
        { path: reference.path },
      )}
      variant="link"
    >
      {reference.kind === "dir" ? (
        <FolderOpen aria-hidden="true" size={13} />
      ) : (
        <FileText aria-hidden="true" size={13} />
      )}
      {code ? <code>{children}</code> : <span>{children}</span>}
    </Button>
  );
}

/**
 * Markdown components that turn the answer's verified paths into buttons: a
 * code span whose text, or a link whose authored target, is one of them.
 * Every other link renders as a MarkdownLink.
 */
function fileLinkComponents(
  references: ConversationFileReference[],
  onOpen: (reference: ConversationFileReference) => void,
): Components {
  const byText = new Map(
    references.map((reference) => [reference.text, reference]),
  );
  return {
    ...markdownComponents,
    inlineCode: ({ children, node: _node, ...props }) => {
      const reference = byText.get(nodeText(children).trim());
      return reference ? (
        <FileReferenceButton code onOpen={onOpen} reference={reference}>
          {children}
        </FileReferenceButton>
      ) : (
        <code {...props}>{children}</code>
      );
    },
    a: ({ children, href, node, ...props }) => {
      const target = relativeLinkTarget(node) ?? href;
      const reference = target
        ? (byText.get(target) ?? byText.get(decodedHref(target)))
        : undefined;
      if (!reference)
        return (
          <MarkdownLink {...props} href={href} node={node}>
            {children}
          </MarkdownLink>
        );
      // A link around a code span keeps its code look without nesting.
      const only = node?.children.length === 1 ? node.children[0] : undefined;
      const onlyCode = only?.type === "element" && only.tagName === "code";
      return (
        <FileReferenceButton
          code={onlyCode}
          onOpen={onOpen}
          reference={reference}
        >
          {syntaxText(node) || href}
        </FileReferenceButton>
      );
    },
  };
}

// Streamdown stacks its top-level blocks with `space-y`; route that gap to the
// stylesheet's per-block flow space instead of a fixed 1rem.
const markdownFlowClassName = "space-y-[var(--fdy-markdown-flow-space)]";

// Text a person typed keeps its line breaks, as chat products do; agent
// answers stay standard Markdown, where a single newline is a soft break.
const typedTextRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

function MarkdownText({
  children,
  components = markdownComponents,
  streaming,
  typedText,
}: {
  children: string;
  components?: Components;
  streaming: boolean;
  typedText: boolean;
}) {
  return (
    <Streamdown
      animated={streamingTextAnimation}
      className={markdownFlowClassName}
      components={components}
      isAnimating={streaming}
      mode="streaming"
      parseIncompleteMarkdown={streaming}
      rehypePlugins={markdownRehypePlugins}
      remarkPlugins={typedText ? typedTextRemarkPlugins : undefined}
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
  fileReferences,
  onImagePreview,
  onOpenFileReference,
  streaming = false,
  typedText = false,
}: {
  children: ReactNode;
  /** Verified paths to link; nothing is linked while the text streams. */
  fileReferences?: ConversationFileReference[];
  onImagePreview?: (image: ParsedImageTag) => void;
  onOpenFileReference?: (reference: ConversationFileReference) => void;
  streaming?: boolean;
  /** A person's own message: literal list markers and line breaks. */
  typedText?: boolean;
}) {
  const components = useMemo(
    () =>
      fileReferences?.length && onOpenFileReference && !streaming
        ? fileLinkComponents(fileReferences, onOpenFileReference)
        : markdownComponents,
    [fileReferences, onOpenFileReference, streaming],
  );
  // Streamdown keeps rendered blocks while their text is unchanged; new
  // links (the turn ended, its paths verified) need a fresh render.
  const linked =
    components === markdownComponents
      ? ""
      : (fileReferences ?? []).map((reference) => reference.text).join("\n");
  if (typeof children !== "string") {
    return <>{children}</>;
  }
  const content = typedText ? preserveLiteralListMarkers(children) : children;
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
          <MarkdownText
            components={components}
            key={`text-${index}:${linked}`}
            streaming={streaming}
            typedText={typedText}
          >
            {segment.text}
          </MarkdownText>
        ) : null,
      )}
    </>
  );
}

const processLabelIcons: Partial<Record<ProcessLabelKey, typeof Zap>> = {
  searching: Search,
  searched: Search,
  loadedWorkspace: FileText,
  compactingContext: FileText,
  contextCompacted: FileText,
  runningCommand: Terminal,
  ranCommand: Terminal,
  usingTool: Terminal,
  usedTool: Terminal,
  toolFailed: Terminal,
  permissionDenied: ShieldAlert,
};

function ProcessItemIcon({
  title,
  labelKey,
}: {
  title: string;
  labelKey?: ProcessLabelKey;
}) {
  if (labelKey) {
    const Icon = processLabelIcons[labelKey] ?? Zap;
    return <Icon size={15} />;
  }
  // Agent-provided titles, in either language.
  const normalized = title.toLowerCase();
  // i18n-ignore: matches agent-provided titles
  if (normalized.includes("搜索") || normalized.includes("search")) {
    return <Search size={15} />;
  }
  if (
    // i18n-ignore: matches agent-provided titles
    normalized.includes("读取") ||
    // i18n-ignore: matches agent-provided titles
    normalized.includes("加载") ||
    normalized.includes("loaded") ||
    normalized.includes("file") ||
    normalized.includes("skill") ||
    normalized.includes("workspace") ||
    // i18n-ignore: matches agent-provided titles
    normalized.includes("上下文")
  ) {
    return <FileText size={15} />;
  }
  if (
    normalized.includes("sdk") ||
    normalized.includes("cli") ||
    normalized.includes("profile") ||
    // i18n-ignore: matches agent-provided titles
    normalized.includes("命令") ||
    // i18n-ignore: matches agent-provided titles
    normalized.includes("工具")
  ) {
    return <Terminal size={15} />;
  }
  // i18n-ignore: matches agent-provided titles
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
  const fallbackTitle =
    typeof title === "string"
      ? title
      : i18n.t("conversation:process.processed");
  const activeItem = processItems?.[processItems.length - 1];
  if (activeItem) {
    return {
      detail: activeItem.snippet,
      iconTitle: activeItem.title,
      iconLabelKey: activeItem.labelKey,
      title: processDisplaySummaryTitle(processItems, fallbackTitle, streaming),
    };
  }
  return {
    detail: "",
    iconTitle: fallbackTitle,
    iconLabelKey: processLabelKey(fallbackTitle),
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
  const { t } = useTranslation("conversation");
  const [copied, setCopied] = useState(false);

  return (
    <div className="fdy-chat-process-tool-detail">
      <span>{label}</span>
      <Button
        aria-label={
          copied ? t("message.copiedToolDetail") : t("message.copyToolDetail")
        }
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
      <ProcessItemIcon title={item.title} labelKey={item.labelKey} />
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
  const { t } = useTranslation(["conversation", "common"]);
  const [copied, setCopied] = useState(false);

  return (
    <Button
      aria-label={
        copied ? t("common:actions.copied") : t("message.copyMessage")
      }
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
  durationMs,
  items,
  onImagePreview,
  startedAt,
  stepUsage,
  streaming = false,
  text,
  title,
}: {
  durationMs?: number;
  /** The first step's time; a running group counts up from it. */
  startedAt?: string;
  stepUsage?: StepUsage;
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
          <ProcessItemIcon
            title={summary.iconTitle}
            labelKey={summary.iconLabelKey}
          />
        )}
        <span className="fdy-chat-process-trigger-copy">
          <strong>{summary.title}</strong>
          {streaming && summary.detail ? (
            <span className="fdy-chat-process-trigger-detail">
              {summary.detail}
            </span>
          ) : null}
          {streaming && startedAt ? (
            <ProcessElapsed startedAt={startedAt} />
          ) : !streaming && (durationMs || stepUsage) ? (
            <span
              className="fdy-chat-process-trigger-detail"
              title={stepUsage ? stepUsageTitle(stepUsage) : undefined}
            >
              {[
                durationMs ? formatDuration(durationMs) : "",
                stepUsage ? stepUsageSummary(stepUsage) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
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
  const { t } = useTranslation("conversation");
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
          <strong>{title ?? t("message.context")}</strong>
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
  const { t } = useTranslation("conversation");
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
      aria-label={t("message.imagePreview")}
      aria-modal="true"
      className="fdy-image-preview"
      role="dialog"
    >
      <Button
        aria-label={t("message.closeImagePreview")}
        className="fdy-image-preview-backdrop"
        onClick={onClose}
        variant="ghost"
      />
      <div className="fdy-image-preview-panel">
        <div className="fdy-image-preview-topbar">
          <span>{image.alt}</span>
          <Button
            aria-label={t("message.closeImagePreview")}
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
