import {
  ArrowRight,
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
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { TraceChevron, TraceSpinner } from "../ui/trace";
import { CopyButton } from "../ui/copy-button";
import { Chip } from "../ui/chip";
import { DiffStat } from "../ui/diff-stat";
import { Shimmer } from "../ui/shimmer";
import {
  compactProcessToolDetail,
  isProcessRowRunning,
  processToolDiff,
  processDisplayRows,
  processDisplaySummary,
  type ProcessDisplayRow,
  type ProcessDisplayItem,
} from "./chat-process-display";
import { formatDuration, stepUsageSummary, stepUsageTitle } from "./turn-usage";
import { MarkdownContent } from "./markdown-content";
import { ProcessElapsed } from "./process-elapsed";
import type {
  ConversationLiveActivity,
  ConversationToolFrame,
  ParsedImageTag,
  StepUsage,
} from "./conversation-types";
import { FrameThumbnail, frameTime } from "./frame-thumbnail";
import { sessionFrameImageUrl } from "../../api";

/** What a running or finished group says beside its title, quieter than it. */
const triggerDetailClass =
  "min-w-0 flex-[1_1000_auto] truncate font-medium text-ink-faint not-italic";

/** The step list hangs off one guide line; rows are single lines, never cards. */
const itemRowClass =
  "flex h-[30px] min-h-[30px] w-full min-w-0 items-center justify-start gap-2 rounded-sm px-1.5 py-[3px] text-left text-sm leading-[1.35] text-ink-faint [&_svg]:flex-none [&_svg]:stroke-2 [&_svg]:text-ink-faint";

/** Opens a frame: the screen panel when the host has one, else the image. */
function useOpenFrame(
  onOpenScreen?: (frame: ConversationToolFrame) => void,
  onImagePreview?: (image: ParsedImageTag) => void,
) {
  const { t, i18n: active } = useTranslation("conversation");
  const label = (frame: ConversationToolFrame) =>
    t("process.frameThumb", {
      source: t(`process.frameSource.${frame.source}`),
      time: frameTime(frame, active.language),
    });
  const open = (frame: ConversationToolFrame) => {
    if (onOpenScreen) onOpenScreen(frame);
    else
      onImagePreview?.({
        alt: label(frame),
        path: frame.path,
        source: sessionFrameImageUrl(frame.sessionId, frame.id),
      });
  };
  return { label, open };
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

function CompactToolDetailCard({
  content,
  label,
}: {
  content: string;
  label: string;
}) {
  const { t } = useTranslation("conversation");

  return (
    <div className="group/detail relative max-w-full overflow-hidden rounded-lg bg-panel-soft">
      <span className="block pt-2 pr-[42px] pb-0.5 pl-3 text-2xs leading-[1.35] font-semibold text-ink-faint">
        {label}
      </span>
      <CopyButton
        className="absolute top-[5px] right-1.5 z-1 size-[26px] rounded-sm p-0 text-ink-faint opacity-0 group-hover/detail:opacity-100 hover:bg-control-ghost-hover hover:text-ink focus-visible:opacity-100 no-hover:opacity-100 data-[copied=true]:text-success-text data-[copied=true]:opacity-100"
        copiedLabel={t("message.copiedToolDetail")}
        label={t("message.copyToolDetail")}
        text={content}
      />
      <pre className="max-h-[220px] overflow-auto py-[7px] pr-10 pb-[11px] pl-3 font-mono text-2xs leading-normal wrap-anywhere whitespace-pre-wrap text-ink-muted">
        {content}
      </pre>
    </div>
  );
}

function ProcessDisclosureItem({
  active,
  item,
  onImagePreview,
  onOpenScreen,
}: {
  active: boolean;
  item: ProcessDisplayRow;
  onImagePreview?: (image: ParsedImageTag) => void;
  onOpenScreen?: (frame: ConversationToolFrame) => void;
}) {
  const [open, setOpen] = useState(false);
  const frame = useOpenFrame(onOpenScreen, onImagePreview);
  const expandable = Boolean(item.detail);
  const compactToolDetail = compactProcessToolDetail(item);
  const diff = processToolDiff(item);
  const summary = (
    <>
      <ProcessItemIcon title={item.title} labelKey={item.labelKey} />
      <span className="fdy-chat-process-item-copy flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <strong className="flex-none font-semibold whitespace-nowrap text-ink">
          {active ? <Shimmer>{item.title}</Shimmer> : item.title}
        </strong>
        {item.snippet ? (
          item.kind === "tool" ? (
            <Chip>{item.snippet}</Chip>
          ) : (
            <span className="fdy-chat-process-item-value relative min-w-0 truncate text-xs font-medium text-ink-muted">
              {item.snippet}
            </span>
          )
        ) : null}
        {diff ? <DiffStat added={diff.added} removed={diff.removed} /> : null}
      </span>
      {expandable ? <TraceChevron className="ml-auto" size={14} /> : null}
    </>
  );

  return (
    <div
      className="fdy-chat-process-item grid min-w-0 gap-0.5"
      data-active={active ? "true" : "false"}
      data-kind={item.kind}
      data-open={open ? "true" : "false"}
    >
      {expandable ? (
        <Button
          aria-expanded={open}
          className={cn(
            "fdy-chat-process-item-trigger group/trace cursor-pointer hover:bg-control-ghost-hover focus-visible:bg-control-ghost-hover",
            itemRowClass,
          )}
          onClick={() => setOpen((value) => !value)}
          variant="ghost"
        >
          {summary}
        </Button>
      ) : (
        <div className={cn("fdy-chat-process-item-trigger", itemRowClass)}>
          {summary}
        </div>
      )}
      {item.frames?.length ? (
        <div className="mb-1.5 ml-[25px] flex flex-wrap gap-1.5">
          {item.frames.map((value) => (
            <FrameThumbnail
              frame={value}
              key={value.id}
              label={frame.label(value)}
              onOpen={() => frame.open(value)}
              size="row"
            />
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="min-w-0 pt-[3px] pr-1 pb-2.5 pl-[25px] text-ink-muted [&>:last-child]:mb-0">
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

/**
 * The group's newest screenshot and a way to the screen panel, shown
 * whether the group is open or not; the panel never opens by itself.
 */
function ProcessScreenLink({
  frames,
  onImagePreview,
  onOpenScreen,
}: {
  frames: ConversationToolFrame[];
  onImagePreview?: (image: ParsedImageTag) => void;
  onOpenScreen?: (frame: ConversationToolFrame) => void;
}) {
  const { t } = useTranslation("conversation");
  const frame = useOpenFrame(onOpenScreen, onImagePreview);
  const latest = frames[frames.length - 1]!;
  return (
    <div className="mt-0.5 mr-0 mb-1.5 ml-[23px] flex flex-wrap items-end gap-x-3 gap-y-1.5">
      <FrameThumbnail
        frame={latest}
        label={frame.label(latest)}
        onOpen={() => frame.open(latest)}
      />
      <Button
        className="gap-1"
        onClick={() => frame.open(latest)}
        size="sm"
        variant="link"
      >
        {frames.length > 1
          ? t("process.viewScreenCount", { count: frames.length })
          : t("process.viewScreen")}
        <ArrowRight aria-hidden="true" size={13} />
      </Button>
    </div>
  );
}

export function ProcessDisclosure({
  durationMs,
  items,
  liveActivity,
  onImagePreview,
  onOpenScreen,
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
  /**
   * The tool call running now, wherever it started: a running row without
   * a running step of its own shows it, with its time.
   */
  liveActivity?: ConversationLiveActivity;
  onImagePreview?: (image: ParsedImageTag) => void;
  /** Opens the screen panel on a step's screenshot. */
  onOpenScreen?: (frame: ConversationToolFrame) => void;
  streaming?: boolean;
  text: ReactNode;
  title: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const processItems = processDisplayRows(items, streaming);
  const frames = processItems.flatMap((item) => item.frames ?? []);
  const summary = processDisplaySummary(
    processItems,
    typeof title === "string"
      ? title
      : i18n.t("conversation:process.processed"),
    streaming,
  );
  const activeItem = processItems.at(-1);
  // The row's own running step is that call: it keeps its title and time
  // and tells what the call runs.
  const showsCall = Boolean(
    activeItem &&
    isProcessRowRunning(activeItem) &&
    liveActivity?.callId &&
    activeItem.callId === liveActivity.callId,
  );
  const activity = streaming && !showsCall ? liveActivity : undefined;
  const triggerTitle = activity?.title ?? summary.title;
  const triggerDetail =
    activity?.detail ??
    (streaming && showsCall && liveActivity?.detail
      ? liveActivity.detail
      : summary.detail);
  const elapsedFrom = activity?.startedAt ?? startedAt;
  return (
    <section
      className="fdy-chat-process group/process relative -mt-1 w-full has-[+article]:-mb-2.5"
      data-live={streaming ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      <Button
        aria-expanded={open}
        className="fdy-chat-process-trigger group/trace inline-flex min-h-8 max-w-[min(100%,720px)] items-center justify-start gap-2 rounded-lg bg-transparent px-0 py-[5px] text-sm leading-none font-[650] text-ink-muted hover:bg-transparent [&_svg]:flex-none [&_svg]:text-ink-faint"
        onClick={() => setOpen((value) => !value)}
        variant="ghost"
      >
        {streaming ? (
          <TraceSpinner className="border-t-brand-dark" />
        ) : (
          <ProcessItemIcon
            title={summary.iconTitle}
            labelKey={summary.iconLabelKey}
          />
        )}
        <span className="fdy-chat-process-trigger-copy inline-flex min-w-0 flex-1 items-baseline gap-[7px]">
          <strong className="min-w-0 flex-[0_1_auto] truncate font-[650] text-ink-muted not-italic">
            {streaming ? <Shimmer>{triggerTitle}</Shimmer> : triggerTitle}
          </strong>
          {streaming && triggerDetail ? (
            <span className={triggerDetailClass}>{triggerDetail}</span>
          ) : null}
          {streaming && elapsedFrom ? (
            <ProcessElapsed
              limitMs={activity?.limitMs}
              startedAt={elapsedFrom}
            />
          ) : !streaming && (durationMs || stepUsage) ? (
            <span
              className={triggerDetailClass}
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
        <TraceChevron />
      </Button>
      {frames.length > 0 && !open ? (
        <ProcessScreenLink
          frames={frames}
          onImagePreview={onImagePreview}
          onOpenScreen={onOpenScreen}
        />
      ) : null}
      {open ? (
        <div className="grid grid-rows-[1fr]">
          <div className="fdy-chat-process-body-inner max-h-[min(360px,50vh)] min-h-0 w-full max-w-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain py-[7px] pr-1 pb-2 pl-0 text-sm leading-[1.55] text-ink-muted [scrollbar-gutter:stable]">
            {processItems.length > 0 ? (
              <div className="fdy-chat-process-items ml-2 grid gap-px border-l border-line-strong pt-px pb-[3px] pl-3">
                {processItems.map((item, index) => (
                  <ProcessDisclosureItem
                    active={streaming && isProcessRowRunning(item)}
                    item={item}
                    key={item.id ?? `${item.title}-${index}`}
                    onImagePreview={onImagePreview}
                    onOpenScreen={onOpenScreen}
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
      className="fdy-chat-tool-call -my-1 w-[min(100%,720px)] text-ink-faint"
      data-active={streaming ? "true" : "false"}
      data-open={open ? "true" : "false"}
    >
      <Button
        aria-expanded={open}
        className="group/trace min-h-7 w-full max-w-full justify-start gap-[7px] rounded-sm px-0.5 py-[3px] font-normal text-ink-faint select-none hover:bg-control-ghost-hover"
        onClick={() => setOpen((value) => !value)}
        variant="ghost"
      >
        <span className="inline-flex size-5 flex-none items-center justify-center rounded-xs text-ink-faint">
          {streaming ? <TraceSpinner /> : <FileText size={14} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          <strong className="flex-none text-sm leading-tight font-semibold whitespace-nowrap text-ink-faint">
            {title ?? t("message.context")}
          </strong>
          {snippet ? (
            <span className="min-w-0 truncate text-xs leading-tight font-medium text-ink-faint">
              {snippet}
            </span>
          ) : null}
        </span>
        <TraceChevron />
      </Button>
      {open ? (
        <pre className="mt-1 ml-7 max-h-[260px] overflow-x-hidden overflow-y-auto rounded-lg bg-panel-soft px-3 py-2.5 font-mono text-2xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink">
          {text}
        </pre>
      ) : null}
    </section>
  );
}
