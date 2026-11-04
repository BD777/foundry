import { List, FolderTree, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { TextInput } from "./field";
import {
  fileTreeFilterThreshold,
  type FileTreeItem,
  type FileTreeRoot,
  type FileTreeView,
} from "./file-tree-model";
import { FileTreeFileRow, FileTreeFolderRow } from "./file-tree-rows";
import { SegmentedControl } from "./segmented-control";
import { useFileTree } from "./use-file-tree";
import { useFileTreeNavigation } from "./use-file-tree-navigation";

export {
  commonFolder,
  fileTreeFilterThreshold,
  fileTreeNodes,
  fileTreeOpenLimit,
  rootPrefix,
  type FileTreeFileNode,
  type FileTreeFolderNode,
  type FileTreeItem,
  type FileTreeNode,
  type FileTreeRoot,
} from "./file-tree-model";
export { fileIconForName } from "./file-tree-rows";

export interface FileTreeProps {
  "aria-label": string;
  /** The section's title, shown in the header row beside the view switch. */
  heading?: ReactNode;
  roots: FileTreeRoot[];
  selectedId?: string;
  onSelect: (item: FileTreeItem) => void;
  /**
   * Files to show: their folders open and the first takes the focus, e.g.
   * the files in a folder an answer names. A new object is a new request.
   */
  reveal?: { ids: string[] };
}

/**
 * Files as a navigable tree or flat list: folders that hold one folder
 * collapse into one row, shared leading folders move into the root heading,
 * large trees start closed and gain a filter. Arrow keys move between rows;
 * Left and Right close and open folders.
 */
export function FileTree({
  "aria-label": ariaLabel,
  heading,
  onSelect,
  reveal,
  roots,
  selectedId,
}: FileTreeProps) {
  const { t } = useTranslation("ui");
  const tree = useFileTree({ reveal, roots, selectedId });
  const { rows, filter } = tree;
  const navigation = useFileTreeNavigation({
    clearPendingFocus: tree.clearPendingFocus,
    isOpen: tree.isOpen,
    pendingFocus: tree.pendingFocus,
    rows,
    selectedId,
    setOpen: tree.setOpen,
  });

  const elements: ReactNode[] = [];
  let previousRoot: string | undefined;
  for (const row of rows) {
    if (row.rootId !== previousRoot) {
      const entry = tree.trees.find((each) => each.root.id === row.rootId)!;
      elements.push(
        <div
          className="fdy-file-tree-root flex min-w-0 items-baseline gap-1.5 px-1 pt-2 pb-1 text-2xs leading-[1.3] text-ink-faint first:pt-0"
          key={`${row.rootId}:root`}
        >
          <strong className="flex-none font-[650]">{entry.root.label}</strong>
          {entry.prefix ? (
            <span className="min-w-0 truncate font-mono" title={entry.prefix}>
              {entry.prefix}
            </span>
          ) : null}
        </div>,
      );
      previousRoot = row.rootId;
    }
    const focus = {
      depth: Math.min(row.depth, 8),
      onFocus: () => navigation.setActiveKey(row.key),
      rowRef: navigation.bind(row.key),
      tabbable: row.key === navigation.tabKey,
    };
    const node = row.node;
    if (node.kind === "folder") {
      const open = tree.isOpen(row.rootId, node.path);
      elements.push(
        <FileTreeFolderRow
          focus={focus}
          key={row.key}
          node={node}
          onToggle={() => {
            navigation.setActiveKey(row.key);
            tree.setOpen(row, !open);
          }}
          open={open}
        />,
      );
      continue;
    }
    elements.push(
      <FileTreeFileRow
        focus={focus}
        key={row.key}
        node={node}
        onClick={() => {
          navigation.setActiveKey(row.key);
          onSelect(node.item);
        }}
        row={row}
        selected={node.item.id === selectedId}
      />,
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">{heading}</div>
        <FileTreeViewSwitch onChange={tree.setView} view={tree.view} />
      </div>
      {tree.total > fileTreeFilterThreshold ? (
        <FileTreeFilter filter={filter} onChange={tree.setFilter} />
      ) : null}
      {elements.length === 0 ? (
        <p className="m-0 px-1.5 py-2.5 text-xs text-ink-faint">
          {t("fileTree.noMatches", { query: filter.trim() })}
        </p>
      ) : (
        <div
          aria-label={ariaLabel}
          className="grid min-w-0 gap-px"
          onKeyDown={navigation.onKeyDown}
          role="group"
        >
          {elements}
        </div>
      )}
    </div>
  );
}

function FileTreeViewSwitch({
  onChange,
  view,
}: {
  onChange: (view: FileTreeView) => void;
  view: FileTreeView;
}) {
  const { t } = useTranslation("ui");
  return (
    <SegmentedControl
      aria-label={t("fileTree.view")}
      className="flex-none"
      onValueChange={onChange}
      options={[
        {
          icon: <FolderTree aria-hidden="true" size={13} />,
          label: t("fileTree.tree"),
          value: "tree",
        },
        {
          icon: <List aria-hidden="true" size={13} />,
          label: t("fileTree.list"),
          value: "list",
        },
      ]}
      size="sm"
      value={view}
    />
  );
}

function FileTreeFilter({
  filter,
  onChange,
}: {
  filter: string;
  onChange: (filter: string) => void;
}) {
  const { t } = useTranslation("ui");
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-faint">
      <Search aria-hidden="true" size={14} />
      <TextInput
        aria-label={t("fileTree.filter")}
        className="min-w-0 flex-1"
        tone="boxed"
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("fileTree.filterPlaceholder")}
        type="search"
        value={filter}
      />
      {filter ? (
        <Button
          aria-label={t("fileTree.clearFilter")}
          onClick={() => onChange("")}
          size="icon"
          variant="ghost"
        >
          <X size={13} />
        </Button>
      ) : null}
    </div>
  );
}
