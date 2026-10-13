// What a file tree shows: roots of files as folders and rows, without UI.

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

export type FileTreeView = "tree" | "list";

export interface FileTreeRow {
  key: string;
  rootId: string;
  depth: number;
  node: FileTreeNode;
  /** Key of the row's parent folder, for moving left. */
  parent?: string;
  /** List view: the file's folder below the root. */
  folder?: string;
  /** Tree view beside folders: a gap where a chevron would be. */
  chevronGap?: boolean;
}

export function folderKey(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}

export function fileKey(rootId: string, id: string): string {
  return `${rootId}:file:${id}`;
}

/** Keys of the folders that hold any of the given files. */
export function foldersHolding(
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

/** A root, filtered to the query, with its heading prefix and its tree. */
export interface FileTreeEntry {
  root: FileTreeRoot;
  prefix: string;
  nodes: FileTreeNode[];
}

/** The roots with files matching `query` (lowercase; empty: all). */
export function fileTreeEntries(
  roots: FileTreeRoot[],
  query: string,
): FileTreeEntry[] {
  return roots
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
    }));
}

/** The first of the given files, by path, as a row key. */
export function firstFileKey(
  roots: FileTreeRoot[],
  ids: ReadonlySet<string>,
): string | undefined {
  return roots
    .flatMap((root) =>
      root.items
        .filter((item) => ids.has(item.id))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((item) => fileKey(root.id, item.id)),
    )
    .at(0);
}

/**
 * The rows on screen: a list view's files by path, each with its folder, or
 * a tree view's folders and files, below the open folders only.
 */
export function fileTreeRows(
  trees: FileTreeEntry[],
  view: FileTreeView,
  isOpen: (rootId: string, path: string) => boolean,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
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
    // A root of only files needs no chevron column.
    const chevronGap = nodes.some((node) => node.kind === "folder");
    const walk = (list: FileTreeNode[], depth: number, parent?: string) => {
      for (const node of list) {
        const key =
          node.kind === "folder"
            ? folderKey(root.id, node.path)
            : fileKey(root.id, node.item.id);
        rows.push({ chevronGap, key, rootId: root.id, depth, node, parent });
        if (node.kind === "folder" && isOpen(root.id, node.path))
          walk(node.children, depth + 1, key);
      }
    };
    walk(nodes, 0);
  }
  return rows;
}
