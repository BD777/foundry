import {
  ChevronRight,
  FileText,
  Search,
  ShieldAlert,
  Terminal,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import type { ProcessLabelKey } from "../../lib/process-labels";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import {
  compactProcessToolDetail,
  isProcessRowRunning,
  processDisplayRows,
  processDisplaySummary,
  type ProcessDisplayRow,
  type ProcessDisplayItem,
} from "./chat-process-display";
import { formatDuration, stepUsageSummary, stepUsageTitle } from "./turn-usage";
import { MarkdownContent } from "./markdown-content";
import { ProcessElapsed } from "./process-elapsed";
import type { ParsedImageTag, StepUsage } from "./conversation-types";

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

function CompactToolDetailCard({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const { t } = useTranslation("conversation");

  return (
    <div className="fdy-chat-process-tool-detail">
      <span>{label}</span>
      <CopyButton
        className="fdy-chat-process-tool-copy"
        copiedLabel={t("message.copiedToolDetail")}
        label={t("message.copyToolDetail")}
        text={content}
      />
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
  /** When the group began; a running group counts up from it. */
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
  const summary = processDisplaySummary(
    processItems,
    typeof title === "string"
      ? title
      : i18n.t("conversation:process.processed"),
    streaming,
  );
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
                    active={streaming && isProcessRowRunning(item)}
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
