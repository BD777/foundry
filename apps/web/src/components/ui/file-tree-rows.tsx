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
import { Button } from "./button";
import type {
  FileTreeFileNode,
  FileTreeFolderNode,
  FileTreeRow,
} from "./file-tree-model";

export function fileIconForName(name: string) {
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  switch (extension) {
    case "md":
    case "txt":
    case "log":
    case "rtf":
      return <FileText aria-hidden="true" size={15} />;
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
    case "html":
    case "css":
    case "scss":
    case "sh":
    case "bash":
    case "zsh":
      return <FileCode aria-hidden="true" size={15} />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
    case "csv":
      return <FileSpreadsheet aria-hidden="true" size={15} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return <FileImage aria-hidden="true" size={15} />;
    default:
      return <File aria-hidden="true" size={15} />;
  }
}

/** What every row's button shares: depth, focus and its place in Tab order. */
export interface FileTreeRowFocus {
  depth: number;
  onFocus: () => void;
  rowRef: Ref<HTMLButtonElement>;
  tabbable: boolean;
}

function rowButtonProps({
  depth,
  onFocus,
  rowRef,
  tabbable,
}: FileTreeRowFocus) {
  return {
    className: "fdy-file-tree-row",
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
      <span className="fdy-file-tree-name">{node.name}</span>
      <span className="fdy-file-tree-count">{node.fileCount}</span>
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
      data-kind="file"
      data-selected={selected ? "true" : "false"}
      onClick={onClick}
      title={item.title ?? item.path}
    >
      {row.chevronGap ? (
        <span className="fdy-file-tree-indent" aria-hidden="true" />
      ) : null}
      {fileIconForName(node.name)}
      <span className="fdy-file-tree-name">
        {node.name}
        {row.folder ? <em>{row.folder}</em> : null}
      </span>
      {item.lineChanges ? (
        <span
          aria-label={t("fileTree.lineChanges", item.lineChanges)}
          className="fdy-file-tree-lines"
          role="img"
        >
          <span data-tone="added">+{item.lineChanges.added}</span>
          <span data-tone="removed">−{item.lineChanges.removed}</span>
        </span>
      ) : null}
      {item.status ? (
        <span
          aria-label={item.statusLabel}
          className="fdy-file-tree-status"
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
