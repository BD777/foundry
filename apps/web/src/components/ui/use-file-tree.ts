import { useEffect, useMemo, useState } from "react";
import {
  fileTreeEntries,
  fileTreeNodes,
  fileTreeOpenLimit,
  fileTreeRows,
  firstFileKey,
  folderKey,
  foldersHolding,
  type FileTreeRoot,
  type FileTreeRow,
  type FileTreeView,
} from "./file-tree-model";

/**
 * A file tree's view, filter and open folders, and the rows they show. A
 * reveal request opens the folders of its files and names the first one to
 * focus (`pendingFocus`).
 */
export function useFileTree({
  reveal,
  roots,
  selectedId,
}: {
  reveal?: { ids: string[] };
  roots: FileTreeRoot[];
  selectedId?: string;
}) {
  const [view, setView] = useState<FileTreeView>("tree");
  const [filter, setFilter] = useState("");
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [pendingFocus, setPendingFocus] = useState<string>();
  const total = roots.reduce((sum, root) => sum + root.items.length, 0);
  const query = filter.trim().toLowerCase();
  const trees = useMemo(() => fileTreeEntries(roots, query), [query, roots]);
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
    setPendingFocus(firstFileKey(roots, ids));
    // Only a new reveal request opens folders and moves the focus.
  }, [reveal]);

  const isOpen = (rootId: string, path: string): boolean => {
    if (query) return true;
    const key = folderKey(rootId, path);
    return (
      toggled.get(key) ?? (forcedOpen.has(key) || total <= fileTreeOpenLimit)
    );
  };

  const setOpen = (row: FileTreeRow, open: boolean) => {
    if (row.node.kind !== "folder") return;
    const key = folderKey(row.rootId, row.node.path);
    setToggled((current) => new Map(current).set(key, open));
  };

  return {
    view,
    setView,
    filter,
    setFilter,
    /** Files in every root, before the filter. */
    total,
    trees,
    rows: fileTreeRows(trees, view, isOpen),
    isOpen,
    setOpen,
    pendingFocus,
    clearPendingFocus: () => setPendingFocus(undefined),
  };
}
