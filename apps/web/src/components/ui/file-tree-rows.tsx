import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import type {
  FileTreeFileNode,
  FileTreeFolderNode,
  FileTreeRow,
} from "./file-tree-model";

export function fileIconForName(name: string, size = 15) {
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  switch (extension) {
    case "md":
    case "markdown":
    case "mdx":
    case "txt":
    case "log":
    case "rtf":
    case "pdf":
    case "doc":
    case "docx":
      return <FileText aria-hidden="true" size={size} />;
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "py":
    case "go":
    case "rs":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "html":
    case "htm":
    case "css":
    case "scss":
    case "less":
    case "sh":
    case "bash":
    case "zsh":
    case "sql":
      return <FileCode aria-hidden="true" size={size} />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
    case "csv":
    case "tsv":
    case "xlsx":
    case "xls":
      return <FileSpreadsheet aria-hidden="true" size={size} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
    case "ico":
      return <FileImage aria-hidden="true" size={size} />;
    default:
      return <File aria-hidden="true" size={size} />;
  }
}

const nameClass = "fdy-file-tree-name min-w-0 flex-1 truncate";

const statusTone: Record<string, string> = {
  created: "text-success-text",
  modified: "text-warning-text",
  deleted: "text-error-text",
};

/** What every row's button shares: depth, focus and its place in Tab order. */
export interface FileTreeRowFocus {
  depth: number;
  onFocus: () => void;
  rowRef: Ref<HTMLButtonElement>;
  tabbable: boolean;
}

/** Rows sit flush with the root heading; each level adds one 12px step. */
const depthPadding = [
  "pl-1",
  "pl-4",
  "pl-7",
  "pl-10",
  "pl-13",
  "pl-16",
  "pl-19",
  "pl-22",
  "pl-25",
];

const rowClass =
  "fdy-file-tree-row flex h-7 w-full justify-start gap-[5px] rounded-sm pr-1.5 py-0 text-left text-xs font-[450] text-ink hover:bg-control-ghost-hover data-[selected=true]:bg-accent-soft data-[selected=true]:font-[650] data-[selected=true]:text-ink";

function rowButtonProps({
  depth,
  onFocus,
  rowRef,
  tabbable,
}: FileTreeRowFocus) {
  return {
    className: cn(rowClass, depthPadding[depth] ?? depthPadding[8]),
    "data-depth": depth,
    onFocus,
    ref: rowRef,
    tabIndex: tabbable ? 0 : -1,
    variant: "bare" as const,
  };
}

export function FileTreeFolderRow({
  focus,
  node,
  onToggle,
  open,
}: {
  focus: FileTreeRowFocus;
  node: FileTreeFolderNode;
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <Button
      {...rowButtonProps(focus)}
      aria-expanded={open}
      className={cn(
        rowButtonProps(focus).className,
        "[&>svg:nth-of-type(2)]:text-warning-text",
      )}
      data-kind="folder"
      onClick={onToggle}
      title={node.path}
    >
      {open ? (
        <ChevronDown aria-hidden="true" size={14} />
      ) : (
        <ChevronRight aria-hidden="true" size={14} />
      )}
      {open ? (
        <FolderOpen aria-hidden="true" size={15} />
      ) : (
        <Folder aria-hidden="true" size={15} />
      )}
      <span className={nameClass}>{node.name}</span>
      <span className="flex-none text-2xs font-medium text-ink-faint">
        {node.fileCount}
      </span>
    </Button>
  );
}

export function FileTreeFileRow({
  focus,
  node,
  onClick,
  row,
  selected,
}: {
  focus: FileTreeRowFocus;
  node: FileTreeFileNode;
  onClick: () => void;
  row: FileTreeRow;
  selected: boolean;
}) {
  const { t } = useTranslation("ui");
  const item = node.item;
  return (
    <Button
      {...rowButtonProps(focus)}
      aria-pressed={selected}
      className={cn(rowButtonProps(focus).className, "[&>svg]:text-ink-muted")}
      data-kind="file"
      data-selected={selected ? "true" : "false"}
      onClick={onClick}
      title={item.title ?? item.path}
    >
      {row.chevronGap ? (
        <span
          className="fdy-file-tree-indent w-3.5 flex-none"
          aria-hidden="true"
        />
      ) : null}
      {fileIconForName(node.name)}
      <span className={nameClass}>
        {node.name}
        {row.folder ? (
          <em className="ml-1.5 text-2xs font-[450] text-ink-faint not-italic">
            {row.folder}
          </em>
        ) : null}
      </span>
      {item.lineChanges ? (
        <span
          aria-label={t("fileTree.lineChanges", item.lineChanges)}
          className="fdy-file-tree-lines inline-flex flex-none gap-1 text-2xs font-medium tabular-nums"
          role="img"
        >
          <span className="text-success-text" data-tone="added">
            +{item.lineChanges.added}
          </span>
          <span className="text-error-text" data-tone="removed">
            −{item.lineChanges.removed}
          </span>
        </span>
      ) : null}
      {item.status ? (
        <span
          aria-label={item.statusLabel}
          className={cn(
            "fdy-file-tree-status flex-none text-2xs font-semibold text-ink-faint",
            item.tone && statusTone[item.tone],
          )}
          data-tone={item.tone}
          role={item.statusLabel ? "img" : undefined}
          title={item.statusLabel}
        >
          {item.status}
        </span>
      ) : null}
    </Button>
  );
}
