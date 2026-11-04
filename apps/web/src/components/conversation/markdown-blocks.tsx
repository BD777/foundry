import * as RadixDialog from "@radix-ui/react-dialog";
import { Check, Copy, Download, Maximize2, X } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  defaultTranslations,
  extractTableDataFromElement,
  StreamdownContext,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
  type Components,
  type ControlsConfig,
  type ExtraProps,
  type StreamdownTranslations,
} from "streamdown";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { CodeBlock, codeBlockActionClass } from "../ui/code-block";
import { Checkbox } from "../ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  RecordsBody,
  RecordsCell,
  RecordsHead,
  RecordsHeaderCell,
  RecordsRow,
  RecordsTable,
} from "../ui/records-table";

/*
 * What Streamdown's `components` prop replaces, and what it cannot.
 *
 * Replaced (all public API): every block and inline element the answer
 * renders, so the markdown carries Beautiful UI's typography, the code listing
 * (`pre`: CodeBlock) and the table (`table` and its parts: RecordsTable, with
 * shadcn-style menus for its actions, from the table data Streamdown
 * exports).
 *
 * Kept as Streamdown renders it: a Mermaid diagram. Its renderer, pan/zoom,
 * fullscreen and exports live in Streamdown's own `code` component, which is
 * not exported, and replacing `code` would lose them; the `pre` below hands a
 * Mermaid fence on to it (while the diagram plugin is on). Streamdown's
 * images, its link safety dialog and its headings 5 and 6 stay as well.
 * Nothing it renders needs a stylesheet: its own classes read the theme tokens
 * `foundation.css` maps (`bg-sidebar`, `border-border` ...).
 *
 * What only a hook sheet can reach (streamdown-hooks.css): see that file.
 */

/**
 * Vertical rhythm follows GitHub's markdown CSS (tight `li + li`, nested lists
 * flush) on a four-step scale, with Gestalt proximity: a lead-in paragraph sits
 * close to the list it introduces, unrelated blocks keep the full gap. Every
 * gap is a margin-top on the later block, read from `--md-flow`, which the
 * relations below set.
 */
export const blockFlow = cn(
  "mt-(--md-flow) first:mt-0 [--md-flow:1em] [:is(h1,h2,h3,h4)+&]:[--md-flow:0.5em] [li>&]:[--md-flow:0.5em]",
  "[:is([data-frame],[data-streamdown=mermaid-block])+&]:[--md-flow:1.5em]",
);

/**
 * A framed block (a table, a code block, a diagram, a quote panel, an image):
 * 1.5em above and 1.5em below, one rule for all of them (a heading just above
 * included). What follows a frame reads the same gap from `blockFlow`.
 */
export const frameFlow = cn(
  blockFlow,
  "[--md-flow:1.5em] [:is(h1,h2,h3,h4)+&]:[--md-flow:1.5em] [li>&]:[--md-flow:1.5em]",
);

/**
 * The card around a Mermaid diagram, which Streamdown builds itself: its own
 * margins give way to the frame gap, its card takes the hairline-ring surface
 * of the code block and the table. Its controls stay where Streamdown puts
 * them, in the card's header row, always visible.
 */
const diagramFrame = cn(
  frameFlow,
  "mb-0 gap-0 rounded-lg border-0 bg-surface p-2 shadow-card",
);

/** The words of Streamdown's controls, in the viewer's language. */
export function useMarkdownTranslations(): StreamdownTranslations {
  const { t } = useTranslation("conversation");
  return {
    ...defaultTranslations,
    ...t("diagram.controls", { returnObjects: true }),
  };
}

/** Whether a control (copy, download ...) is on, as Streamdown's config says. */
function controlOn(
  controls: ControlsConfig,
  block: "table" | "code",
  control: "copy" | "download" | "fullscreen",
): boolean {
  if (typeof controls === "boolean") return controls;
  const config = controls[block];
  if (config === undefined || config === true) return true;
  if (config === false) return false;
  return (config as Record<string, unknown>)[control] !== false;
}

/** Streamdown hands every element its syntax node; a DOM element must not get it. */
const withoutNode = <P extends object>(
  Component: ComponentType<P>,
): ((props: P & ExtraProps) => ReactNode) =>
  function MarkdownPart({ node: _node, ...props }: P & ExtraProps) {
    return <Component {...(props as unknown as P)} />;
  };

/* ---------------------------------------------------------------- code */

/**
 * A fenced code block. A Mermaid fence is handed on to Streamdown's own `code`
 * component while the diagram plugin is on (a settled message); until then,
 * and for every other language, it is a CodeBlock.
 */
function fencedBlock(delegateMermaid: boolean) {
  return function MarkdownPre({ children }: { children?: ReactNode }) {
    const { controls } = useContext(StreamdownContext);
    const translations = useMarkdownTranslations();
    if (!isValidElement(children)) return children;
    const element = children as ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    const language =
      /language-([^\s]+)/.exec(element.props.className ?? "")?.[1] ?? "";
    if (delegateMermaid && language === "mermaid")
      return cloneElement(element, {
        "data-block": "true",
        className: cn(element.props.className, diagramFrame),
      } as object);
    const code =
      typeof element.props.children === "string" ? element.props.children : "";
    const copy = controlOn(controls, "code", "copy");
    const download = controlOn(controls, "code", "download");
    return (
      <CodeBlock
        actions={
          !copy && !download ? null : (
            <>
              {download ? (
                <CodeBlockDownloadButton
                  className={codeBlockActionClass}
                  code={code}
                  language={language}
                  title={translations.downloadFile}
                />
              ) : null}
              {copy ? (
                <CodeBlockCopyButton
                  className={codeBlockActionClass}
                  code={code}
                  title={translations.copyCode}
                />
              ) : null}
            </>
          )
        }
        className={frameFlow}
        code={code}
        data-frame="true"
        language={language}
      />
    );
  };
}

/* --------------------------------------------------------------- table */

function downloadText(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const tableActionClass = codeBlockActionClass;

/** The table's data, read from the rendered table the actions sit beside. */
function tableDataOf(frame: HTMLElement | null) {
  const table = frame?.querySelector("table");
  return table ? extractTableDataFromElement(table) : undefined;
}

function TableActions({
  fullscreen,
  frame,
  onFullscreen,
}: {
  frame: () => HTMLElement | null;
  fullscreen: boolean;
  onFullscreen?: () => void;
}) {
  const { controls, isAnimating } = useContext(StreamdownContext);
  const t = useMarkdownTranslations();
  const [copied, setCopied] = useState(false);
  const copy = controlOn(controls, "table", "copy");
  const download = controlOn(controls, "table", "download");
  const separator =
    typeof controls === "object" &&
    typeof controls.table === "object" &&
    controls.table.csvSeparator
      ? controls.table.csvSeparator
      : undefined;
  async function copyAs(format: "md" | "csv" | "tsv") {
    const data = tableDataOf(frame());
    if (!data) return;
    const text =
      format === "csv"
        ? tableDataToCSV(data, separator)
        : format === "tsv"
          ? tableDataToTSV(data)
          : tableDataToMarkdown(data);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* The clipboard is not available here; nothing was copied. */
    }
  }
  function downloadAs(format: "csv" | "markdown") {
    const data = tableDataOf(frame());
    if (!data) return;
    if (format === "csv")
      downloadText("table.csv", tableDataToCSV(data, separator), "text/csv");
    else downloadText("table.md", tableDataToMarkdown(data), "text/markdown");
  }
  return (
    <>
      {copy ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={tableActionClass}
              disabled={isAnimating}
              size="icon"
              title={t.copyTable}
              variant="ghost"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => void copyAs("md")}
              title={t.copyTableAsMarkdown}
            >
              {t.tableFormatMarkdown}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void copyAs("csv")}
              title={t.copyTableAsCsv}
            >
              {t.tableFormatCsv}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void copyAs("tsv")}
              title={t.copyTableAsTsv}
            >
              {t.tableFormatTsv}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {download ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={tableActionClass}
              disabled={isAnimating}
              size="icon"
              title={t.downloadTable}
              variant="ghost"
            >
              <Download size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => downloadAs("csv")}
              title={t.downloadTableAsCsv}
            >
              {t.tableFormatCsv}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => downloadAs("markdown")}
              title={t.downloadTableAsMarkdown}
            >
              {t.tableFormatMarkdown}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {fullscreen && onFullscreen ? (
        <Button
          className={tableActionClass}
          disabled={isAnimating}
          onClick={onFullscreen}
          size="icon"
          title={t.viewFullscreen}
          variant="ghost"
        >
          <Maximize2 size={14} />
        </Button>
      ) : null}
    </>
  );
}

function MarkdownTable({ children }: ComponentPropsWithoutRef<"table">) {
  const { controls } = useContext(StreamdownContext);
  const translations = useMarkdownTranslations();
  const frame = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const fullscreen = controlOn(controls, "table", "fullscreen");
  const shown =
    fullscreen ||
    controlOn(controls, "table", "copy") ||
    controlOn(controls, "table", "download");
  return (
    <>
      <div className={frameFlow} data-frame="true" ref={frame}>
        <RecordsTable
          toolbar={
            shown ? (
              <TableActions
                frame={() => frame.current}
                fullscreen={fullscreen}
                onFullscreen={() => setExpanded(true)}
              />
            ) : undefined
          }
        >
          {children}
        </RecordsTable>
      </div>
      {expanded ? (
        <RadixDialog.Root open onOpenChange={setExpanded}>
          <RadixDialog.Portal>
            <RadixDialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-100 flex flex-col bg-surface outline-none"
            >
              <RadixDialog.Title className="sr-only">
                {translations.viewFullscreen}
              </RadixDialog.Title>
              <div className="flex items-center justify-end gap-1 p-4">
                <TableActions frame={() => frame.current} fullscreen={false} />
                <RadixDialog.Close asChild>
                  <Button
                    className={tableActionClass}
                    size="icon"
                    title={translations.exitFullscreen}
                    variant="ghost"
                  >
                    <X size={18} />
                  </Button>
                </RadixDialog.Close>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4 pt-0">
                <RecordsTable tall={false}>{children}</RecordsTable>
              </div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- the rest */

const linkClass = "font-[650] text-info-text underline underline-offset-3";

/** The classes of a link in an answer, for the components that render one. */
export const markdownLinkClass = linkClass;

/** `code` in a sentence. */
export function InlineCode({
  className,
  ...props
}: ComponentPropsWithoutRef<"code">) {
  return (
    <code
      className={cn(
        "rounded-xs bg-panel-soft px-[5px] py-px font-mono text-ink [font-size:0.92em] wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}

function heading(tag: "h1" | "h2" | "h3" | "h4", size: string) {
  const Tag = tag;
  function Heading({ className, ...props }: ComponentPropsWithoutRef<"h1">) {
    return (
      <Tag
        className={cn(
          blockFlow,
          size,
          "[--md-flow:1.5em] leading-tight font-[750] text-ink",
          className,
        )}
        {...props}
      />
    );
  }
  return withoutNode(Heading);
}

function MarkdownParagraph({
  children,
  className,
  node,
  ...props
}: ComponentPropsWithoutRef<"p"> & ExtraProps) {
  // An image or a code block on its own stands without a paragraph around it.
  const only = node?.children.length === 1 ? node.children[0] : undefined;
  if (only?.type === "element" && only.tagName === "img")
    return <>{children}</>;
  return (
    <p className={cn(blockFlow, className)} {...props}>
      {children}
    </p>
  );
}

function MarkdownList({
  children,
  className,
  node: _node,
  ordered,
  ...props
}: ComponentPropsWithoutRef<"ul"> & ExtraProps & { ordered: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={cn(
        blockFlow,
        "pl-[2em] [p+&]:[--md-flow:0.5em] [li>&]:mt-[0.25em]",
        ordered
          ? "list-decimal [:is(ul,ol)_&]:list-[lower-roman]"
          : "list-disc [:is(ul,ol)_&]:list-[circle]",
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}

function MarkdownListItem({
  className,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"li"> & ExtraProps) {
  const task = className?.includes("task-list-item");
  return (
    <li
      className={cn(
        "not-first:mt-[0.25em] [:is(ul,ol):has(>li>p)>&]:not-first:mt-[0.5em]",
        task && "list-none",
        className,
      )}
      {...props}
    />
  );
}

function MarkdownBlockquote({
  className,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"blockquote"> & ExtraProps) {
  return (
    <blockquote
      className={cn(
        frameFlow,
        "rounded-r-md border-l-[3px] border-line-strong bg-panel-soft px-3 py-2 text-ink-muted",
        className,
      )}
      data-frame="true"
      {...props}
    />
  );
}

/** A GFM task item's checkbox takes the bullet's place (GitHub's CSS). */
function MarkdownInput({
  node: _node,
  className,
  ...props
}: ComponentPropsWithoutRef<"input"> & ExtraProps) {
  return (
    <Checkbox
      className={cn(
        "mr-[0.2em] mb-[0.25em] -ml-[1.4em] align-middle",
        className,
      )}
      {...props}
    />
  );
}

/** The components of a message's markdown that do not depend on its state. */
export const markdownBlocks: Components = {
  inlineCode: withoutNode(InlineCode),
  p: MarkdownParagraph,
  h1: heading("h1", "text-2xl"),
  h2: heading("h2", "text-xl"),
  h3: heading("h3", "text-lg"),
  h4: heading("h4", "text-md"),
  ul: (props) => <MarkdownList ordered={false} {...props} />,
  ol: (props) => <MarkdownList ordered {...props} />,
  li: MarkdownListItem,
  blockquote: MarkdownBlockquote,
  input: MarkdownInput,
  table: withoutNode(MarkdownTable),
  thead: withoutNode(RecordsHead),
  tbody: withoutNode(RecordsBody),
  tr: withoutNode(RecordsRow),
  th: withoutNode(RecordsHeaderCell),
  td: withoutNode(RecordsCell),
};

/** `pre`, which carries the code block; one per state of the diagram plugin. */
export const fencedBlocks = {
  plain: fencedBlock(false),
  withDiagrams: fencedBlock(true),
};
