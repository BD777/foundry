import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileTreeRow } from "./file-tree-model";

/**
 * Moving through a file tree's rows: one row takes Tab (the active, else the
 * selected, else the first); arrow keys, Home and End move between rows;
 * Left and Right close and open folders.
 */
export function useFileTreeNavigation({
  clearPendingFocus,
  isOpen,
  pendingFocus,
  rows,
  selectedId,
  setOpen,
}: {
  clearPendingFocus: () => void;
  isOpen: (rootId: string, path: string) => boolean;
  /** A row to focus once it is on screen. */
  pendingFocus?: string;
  rows: FileTreeRow[];
  selectedId?: string;
  setOpen: (row: FileTreeRow, open: boolean) => void;
}) {
  const [activeKey, setActiveKey] = useState<string>();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!pendingFocus) return;
    const row = rowRefs.current.get(pendingFocus);
    if (!row) return;
    setActiveKey(pendingFocus);
    clearPendingFocus();
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

  return {
    tabKey,
    onKeyDown,
    setActiveKey,
    /** The ref of a row's button. */
    bind: (key: string) => (node: HTMLButtonElement | null) => {
      if (node) rowRefs.current.set(key, node);
      else rowRefs.current.delete(key);
    },
  };
}
