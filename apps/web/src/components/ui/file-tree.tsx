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
  FolderTree,
  List,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { TextInput } from "./field";
import { SegmentedControl } from "./segmented-control";
import "./file-tree.css";

/** One file shown in a tree. */
export interface FileTreeItem {
  id: string;
  /** Below its root, `/`-separated (absolute paths keep their leading `/`). */
  path: string;
  /** A short status beside the name, such as "New" or "Edited". */
  status?: string;
  /** Colors the status: created, modified, deleted or referenced. */
  tone?: string;
  /** The status in words, when `status` is an abbreviation such as "M". */
  statusLabel?: string;
  /** Lines added and removed, shown as "+12 −3". */
  lineChanges?: { added: number; removed: number };
  /** Full path or other detail, shown as the row's tooltip. */
  title?: string;
}

/** A group of files listed under one heading, such as "Workspace". */
export interface FileTreeRoot {
  id: string;
  label: string;
  items: FileTreeItem[];
}

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

/** Folders start open only when the whole tree is this small. */
export const fileTreeOpenLimit = 20;
/** A filter box appears above this many files. */
export const fileTreeFilterThreshold = 15;

export interface FileTreeFolderNode {
  kind: "folder";
  /** Compressed single-child chain, e.g. "src/components". */
  name: string;
  /** Root-relative path of the deepest folder in the chain. */
  path: string;
  children: FileTreeNode[];
  fileCount: number;
}

export interface FileTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  item: FileTreeItem;
}

export type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** The folders every item shares, which the root heading shows once. */
export function commonFolder(items: FileTreeItem[]): string[] {
  let common: string[] | undefined;
  for (const item of items) {
    const folders = segments(item.path).slice(0, -1);
    if (!common) {
      common = folders;
      continue;
    }
    let length = 0;
    while (
      length < common.length &&
      length < folders.length &&
      common[length] === folders[length]
    )
      length += 1;
    common = common.slice(0, length);
  }
  return common ?? [];
}

/** The prefix a root's heading shows; absolute paths keep their `/`. */
export function rootPrefix(root: FileTreeRoot): string {
  const common = commonFolder(root.items);
  if (common.length === 0) return "";
  const absolute = root.items.some((item) => item.path.startsWith("/"));
  return `${absolute ? "/" : ""}${common.join("/")}`;
}

/**
 * A root's files as a tree below their shared folders: folders first, each
 * sorted by name, and a folder holding only one folder shown as one row.
 */
export function fileTreeNodes(root: FileTreeRoot): FileTreeNode[] {
  const skip = commonFolder(root.items).length;
  const top: FileTreeFolderNode = {
    kind: "folder",
    name: "",
    path: "",
    children: [],
    fileCount: 0,
  };
  for (const item of root.items) {
    const parts = segments(item.path).slice(skip);
    let folder = top;
    folder.fileCount += 1;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const path = parts.slice(0, index + 1).join("/");
      let next = folder.children.find(
        (child): child is FileTreeFolderNode =>
          child.kind === "folder" && child.path === path,
      );
      if (!next) {
        next = { kind: "folder", name: part, path, children: [], fileCount: 0 };
        folder.children.push(next);
      }
      next.fileCount += 1;
      folder = next;
    }
    folder.children.push({
      kind: "file",
      name: parts.at(-1) ?? item.path,
      path: parts.join("/"),
      item,
    });
  }
  const finish = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .map((node) => {
        if (node.kind === "file") return node;
        let folder = node;
        while (
          folder.children.length === 1 &&
          folder.children[0]!.kind === "folder"
        ) {
          const only = folder.children[0] as FileTreeFolderNode;
          folder = { ...only, name: `${folder.name}/${only.name}` };
        }
        return { ...folder, children: finish(folder.children) };
      })
      .sort((left, right) =>
        left.kind !== right.kind
          ? left.kind === "folder"
            ? -1
            : 1
          : left.name.localeCompare(right.name),
      );
  return finish(top.children);
}

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

interface Row {
  key: string;
  rootId: string;
  depth: number;
  node: FileTreeNode;
  /** Key of the row's parent folder, for moving left. */
  parent?: string;
  /** List view: the file's folder below the root. */
  folder?: string;
}

function folderKey(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}

function fileKey(rootId: string, id: string): string {
  return `${rootId}:file:${id}`;
}

/** Keys of the folders that hold any of the given files. */
function foldersHolding(
  trees: Array<{ root: FileTreeRoot; nodes: FileTreeNode[] }>,
  ids: ReadonlySet<string>,
): Set<string> {
  const open = new Set<string>();
  for (const { root, nodes } of trees) {
    const visit = (node: FileTreeNode): boolean => {
      if (node.kind === "file") return ids.has(node.item.id);
      let found = false;
      for (const child of node.children) found = visit(child) || found;
      if (found) open.add(folderKey(root.id, node.path));
      return found;
    };
    for (const node of nodes) visit(node);
  }
  return open;
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
  const [view, setView] = useState<"tree" | "list">("tree");
  const [filter, setFilter] = useState("");
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [activeKey, setActiveKey] = useState<string>();
  const [pendingFocus, setPendingFocus] = useState<string>();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const total = roots.reduce((sum, root) => sum + root.items.length, 0);
  const query = filter.trim().toLowerCase();
  const trees = useMemo(
    () =>
      roots
        .map((root) =>
          query
            ? {
                ...root,
                items: root.items.filter((item) =>
                  item.path.toLowerCase().includes(query),
                ),
              }
            : root,
        )
        .filter((root) => root.items.length > 0)
        .map((root) => ({
          root,
          prefix: rootPrefix(root),
          nodes: fileTreeNodes(root),
        })),
    [query, roots],
  );
  // Folders holding the selected file stay open.
  const forcedOpen = useMemo(
    () => foldersHolding(trees, new Set(selectedId ? [selectedId] : [])),
    [selectedId, trees],
  );

  useEffect(() => {
    const ids = new Set(reveal?.ids);
    // A request naming none of this tree's files leaves it as it is.
    if (!roots.some((root) => root.items.some((item) => ids.has(item.id))))
      return;
    setView("tree");
    setFilter("");
    const opened = foldersHolding(
      roots.map((root) => ({ root, nodes: fileTreeNodes(root) })),
      ids,
    );
    setToggled((current) => {
      const next = new Map(current);
      for (const key of opened) next.set(key, true);
      return next;
    });
    const first = roots
      .flatMap((root) =>
        root.items
          .filter((item) => ids.has(item.id))
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((item) => fileKey(root.id, item.id)),
      )
      .at(0);
    setPendingFocus(first);
    // Only a new reveal request opens folders and moves the focus.
  }, [reveal]);

  const isOpen = (rootId: string, path: string): boolean => {
    if (query) return true;
    const key = folderKey(rootId, path);
    return (
      toggled.get(key) ?? (forcedOpen.has(key) || total <= fileTreeOpenLimit)
    );
  };

  const rows: Row[] = [];
  for (const { root, nodes } of trees) {
    if (view === "list") {
      const skip = commonFolder(root.items).length;
      for (const item of [...root.items].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        const parts = segments(item.path).slice(skip);
        rows.push({
          key: fileKey(root.id, item.id),
          rootId: root.id,
          depth: 0,
          folder: parts.slice(0, -1).join("/"),
          node: {
            kind: "file",
            name: parts.at(-1) ?? item.path,
            path: parts.join("/"),
            item,
          },
        });
      }
      continue;
    }
    const walk = (list: FileTreeNode[], depth: number, parent?: string) => {
      for (const node of list) {
        const key =
          node.kind === "folder"
            ? folderKey(root.id, node.path)
            : fileKey(root.id, node.item.id);
        rows.push({ key, rootId: root.id, depth, node, parent });
        if (node.kind === "folder" && isOpen(root.id, node.path))
          walk(node.children, depth + 1, key);
      }
    };
    walk(nodes, 0);
  }

  useEffect(() => {
    if (!pendingFocus) return;
    const row = rowRefs.current.get(pendingFocus);
    if (!row) return;
    setActiveKey(pendingFocus);
    setPendingFocus(undefined);
    row.focus();
    row.scrollIntoView?.({ block: "nearest" });
  });

  const selectedKey = rows.find(
    (row) => row.node.kind === "file" && row.node.item.id === selectedId,
  )?.key;
  const tabKey =
    activeKey && rows.some((row) => row.key === activeKey)
      ? activeKey
      : (selectedKey ?? rows[0]?.key);

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setActiveKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const setOpen = (row: Row, open: boolean) => {
    if (row.node.kind !== "folder") return;
    const key = folderKey(row.rootId, row.node.path);
    setToggled((current) => new Map(current).set(key, open));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.key === tabKey);
    const row = rows[index];
    if (!row) return;
    const open =
      row.node.kind === "folder" && isOpen(row.rootId, row.node.path);
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[Math.min(rows.length - 1, index + 1)]?.key);
        break;
      case "ArrowUp":
        focusRow(rows[Math.max(0, index - 1)]?.key);
        break;
      case "Home":
        focusRow(rows[0]?.key);
        break;
      case "End":
        focusRow(rows.at(-1)?.key);
        break;
      case "ArrowRight":
        if (row.node.kind !== "folder") return;
        if (!open) setOpen(row, true);
        else focusRow(rows[index + 1]?.key);
        break;
      case "ArrowLeft":
        if (row.node.kind === "folder" && open) setOpen(row, false);
        else focusRow(row.parent);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const bind = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(key, node);
    else rowRefs.current.delete(key);
  };

  const elements: ReactNode[] = [];
  let previousRoot: string | undefined;
  for (const row of rows) {
    if (row.rootId !== previousRoot) {
      const tree = trees.find((entry) => entry.root.id === row.rootId)!;
      elements.push(
        <div className="fdy-file-tree-root" key={`${row.rootId}:root`}>
          <strong>{tree.root.label}</strong>
          {tree.prefix ? <span title={tree.prefix}>{tree.prefix}</span> : null}
        </div>,
      );
      previousRoot = row.rootId;
    }
    const depth = Math.min(row.depth, 8);
    const shared = {
      className: "fdy-file-tree-row",
      "data-depth": depth,
      onFocus: () => setActiveKey(row.key),
      ref: bind(row.key),
      tabIndex: row.key === tabKey ? 0 : -1,
      variant: "bare" as const,
    };
    if (row.node.kind === "folder") {
      const open = isOpen(row.rootId, row.node.path);
      elements.push(
        <Button
          {...shared}
          aria-expanded={open}
          data-kind="folder"
          key={row.key}
          onClick={() => {
            setActiveKey(row.key);
            setOpen(row, !open);
          }}
          title={row.node.path}
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
          <span className="fdy-file-tree-name">{row.node.name}</span>
          <span className="fdy-file-tree-count">{row.node.fileCount}</span>
        </Button>,
      );
      continue;
    }
    const item = row.node.item;
    const selected = item.id === selectedId;
    elements.push(
      <Button
        {...shared}
        aria-pressed={selected}
        data-kind="file"
        data-selected={selected ? "true" : "false"}
        key={row.key}
        onClick={() => {
          setActiveKey(row.key);
          onSelect(item);
        }}
        title={item.title ?? item.path}
      >
        <span className="fdy-file-tree-indent" aria-hidden="true" />
        {fileIconForName(row.node.name)}
        <span className="fdy-file-tree-name">
          {row.node.name}
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
      </Button>,
    );
  }

  return (
    <div className="fdy-file-tree">
      <div className="fdy-file-tree-header">
        <div className="fdy-file-tree-heading">{heading}</div>
        <SegmentedControl
          aria-label={t("fileTree.view")}
          className="fdy-file-tree-view"
          onValueChange={setView}
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
      </div>
      {total > fileTreeFilterThreshold ? (
        <div className="fdy-file-tree-filter">
          <Search aria-hidden="true" size={14} />
          <TextInput
            aria-label={t("fileTree.filter")}
            className="fdy-file-tree-input"
            tone="boxed"
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("fileTree.filterPlaceholder")}
            type="search"
            value={filter}
          />
          {filter ? (
            <Button
              aria-label={t("fileTree.clearFilter")}
              onClick={() => setFilter("")}
              size="icon"
              variant="ghost"
            >
              <X size={13} />
            </Button>
          ) : null}
        </div>
      ) : null}
      {elements.length === 0 ? (
        <p className="fdy-file-tree-empty">
          {t("fileTree.noMatches", { query: filter.trim() })}
        </p>
      ) : (
        <div
          aria-label={ariaLabel}
          className="fdy-file-tree-rows"
          onKeyDown={onKeyDown}
          role="group"
        >
          {elements}
        </div>
      )}
    </div>
  );
}
