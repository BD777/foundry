import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceTreeEntry } from "@bd777/foundry-protocol";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { listWorkspaceTree } from "../../api";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { fileIconForName } from "../ui/file-tree";
import { formatBytes } from "../../lib/format";
import { Skeleton, Spinner } from "../ui/loading";
import { cn } from "../../lib/cn";

export interface WorkspaceDirectoryBrowserProps {
  workspaceId: string;
  /** Shown as the folder's caption. */
  rootPath?: string;
  /** The folder to list, relative to the workspace; its root by default. */
  startPath?: string;
  onSelectFile: (file: { name: string; path: string }) => void;
  selectedPath?: string;
}

/** Left padding by tree depth: 8px, then 16px per level (clamped at 10). */
const treeIndent = [
  "pl-2",
  "pl-6",
  "pl-10",
  "pl-14",
  "pl-18",
  "pl-22",
  "pl-26",
  "pl-30",
  "pl-34",
  "pl-38",
  "pl-42",
];

const treeRow =
  "flex h-7 w-full justify-start gap-1.5 rounded-none py-0 pr-3 text-left text-xs font-[450] text-ink select-none hover:bg-control-ghost-hover active:scale-100 data-[selected=true]:bg-selection data-[selected=true]:font-semibold";

const centeredMessage =
  "flex min-h-40 flex-col items-center justify-center gap-2.5 p-6 text-center text-sm text-ink-muted";

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "";
  return formatBytes(bytes, { kbDigits: 1 });
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) {
    return <>{text}</>;
  }
  const q = query.trim().toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) {
    return <>{text}</>;
  }
  const before = text.slice(0, idx);
  const matched = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <mark className="rounded-xs bg-accent-soft font-semibold text-inherit">
        {matched}
      </mark>
      <HighlightMatch query={query} text={after} />
    </>
  );
}

interface TreeNodeProps {
  depth: number;
  entry: WorkspaceTreeEntry;
  expandedPaths: Set<string>;
  filterQuery: string;
  folderChildren: Map<string, WorkspaceTreeEntry[]>;
  loadingPaths: Set<string>;
  onSelectFile: (file: { name: string; path: string }) => void;
  onToggleFolder: (path: string) => void;
  selectedPath?: string;
}

function TreeNode({
  depth,
  entry,
  expandedPaths,
  filterQuery,
  folderChildren,
  loadingPaths,
  onSelectFile,
  onToggleFolder,
  selectedPath,
}: TreeNodeProps) {
  const { t } = useTranslation("chat");
  const isDir = entry.isDirectory;
  const isExpanded = isDir && expandedPaths.has(entry.path);
  const isLoading = isDir && loadingPaths.has(entry.path);
  const children = isDir ? folderChildren.get(entry.path) : undefined;
  const isSelected = selectedPath === entry.path;

  // If search filter is active, check if entry or children match
  const matchesSelf =
    !filterQuery ||
    entry.name.toLowerCase().includes(filterQuery.toLowerCase()) ||
    entry.path.toLowerCase().includes(filterQuery.toLowerCase());

  const matchingChildren = useMemo(() => {
    if (!children) return [];
    if (!filterQuery) return children;
    return children.filter((child) => {
      if (child.name.toLowerCase().includes(filterQuery.toLowerCase())) {
        return true;
      }
      if (child.path.toLowerCase().includes(filterQuery.toLowerCase())) {
        return true;
      }
      if (child.isDirectory) {
        // If it's a directory, check if any deeper loaded items match
        const deeper = folderChildren.get(child.path);
        if (
          deeper &&
          deeper.some((d) =>
            d.name.toLowerCase().includes(filterQuery.toLowerCase()),
          )
        ) {
          return true;
        }
      }
      return false;
    });
  }, [children, filterQuery, folderChildren]);

  if (!matchesSelf && matchingChildren.length === 0) {
    return null;
  }

  const depthClamped = Math.min(depth, 10);

  return (
    <div className="flex flex-col">
      {isDir ? (
        <Button
          aria-expanded={isExpanded}
          className={cn(treeRow, treeIndent[depthClamped])}
          data-depth={depthClamped}
          data-expanded={isExpanded ? "true" : "false"}
          data-selected={isSelected ? "true" : "false"}
          onClick={() => onToggleFolder(entry.path)}
          title={entry.path}
          variant="ghost"
        >
          <span
            className="inline-flex size-3.5 flex-none items-center justify-center text-ink-muted"
            aria-hidden="true"
          >
            {isLoading ? (
              <Spinner size={13} />
            ) : isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </span>
          <span
            className="inline-flex size-4 flex-none items-center justify-center text-warning-text"
            aria-hidden="true"
          >
            {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <HighlightMatch query={filterQuery} text={entry.name} />
          </span>
        </Button>
      ) : (
        <Button
          aria-pressed={isSelected}
          className={cn(treeRow, treeIndent[depthClamped])}
          data-depth={depthClamped}
          data-selected={isSelected ? "true" : "false"}
          onClick={() => onSelectFile({ name: entry.name, path: entry.path })}
          title={entry.path}
          variant="ghost"
        >
          <span className="size-3.5 flex-none" aria-hidden="true" />
          <span
            className="inline-flex size-4 flex-none items-center justify-center text-ink-muted"
            aria-hidden="true"
          >
            {fileIconForName(entry.name)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <HighlightMatch query={filterQuery} text={entry.name} />
          </span>
          {entry.size !== undefined ? (
            <span className="ml-auto text-2xs font-normal text-ink-faint">
              {formatSize(entry.size)}
            </span>
          ) : null}
        </Button>
      )}

      {isDir && (isExpanded || filterQuery.trim() !== "") ? (
        <div>
          {matchingChildren.map((child) => (
            <TreeNode
              depth={depth + 1}
              entry={child}
              expandedPaths={expandedPaths}
              filterQuery={filterQuery}
              folderChildren={folderChildren}
              key={child.id || child.path}
              loadingPaths={loadingPaths}
              onSelectFile={onSelectFile}
              onToggleFolder={onToggleFolder}
              selectedPath={selectedPath}
            />
          ))}
          {children && children.length === 0 ? (
            <div
              className={cn(
                "py-1 pr-3 text-2xs text-ink-faint",
                treeIndent[Math.min(depth + 1, 10)],
              )}
            >
              {t("directory.emptyFolder")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceDirectoryBrowser({
  onSelectFile,
  rootPath,
  selectedPath,
  startPath = "",
  workspaceId,
}: WorkspaceDirectoryBrowserProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [entries, setEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [folderChildren, setFolderChildren] = useState<
    Map<string, WorkspaceTreeEntry[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  // The top folder was listed once: reading it again keeps the tree shown.
  const [listed, setListed] = useState(false);
  const [error, setError] = useState<string>();
  const [filterText, setFilterText] = useState("");

  const loadDirectory = async (path = startPath) => {
    const top = path === startPath;
    if (top) {
      setInitialLoading(true);
    } else {
      setLoadingPaths((prev) => new Set(prev).add(path));
    }
    setError(undefined);
    try {
      const items = await listWorkspaceTree({ path, workspaceId });
      if (top) {
        setEntries(items);
        setListed(true);
      } else {
        setFolderChildren((prev) => new Map(prev).set(path, items));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (top) {
        setInitialLoading(false);
      } else {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    setEntries([]);
    setListed(false);
    setFolderChildren(new Map());
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setFilterText("");
    void loadDirectory();
  }, [workspaceId, startPath]);

  const toggleFolder = async (path: string) => {
    if (expandedPaths.has(path)) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedPaths((prev) => new Set(prev).add(path));
    if (!folderChildren.has(path)) {
      await loadDirectory(path);
    }
  };

  const filteredRootEntries = useMemo(() => {
    if (!filterText.trim()) return entries;
    const q = filterText.trim().toLowerCase();
    return entries.filter((item) => {
      if (
        item.name.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q)
      ) {
        return true;
      }
      if (item.isDirectory) {
        const children = folderChildren.get(item.path);
        if (
          children &&
          children.some((c) => c.name.toLowerCase().includes(q))
        ) {
          return true;
        }
      }
      return false;
    });
  }, [entries, filterText, folderChildren]);

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <div className="relative flex flex-1 items-center">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-[9px] text-ink-faint"
            size={14}
          />
          <TextInput
            aria-label={t("directory.filter")}
            className="h-8 py-0 pr-7 pl-[30px] text-sm"
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t("directory.filterPlaceholder")}
            tone="boxed"
            type="search"
            value={filterText}
          />
          {filterText ? (
            <Button
              aria-label={t("directory.clearFilter")}
              className="absolute right-1 size-5 p-0 text-ink-faint hover:text-ink"
              onClick={() => setFilterText("")}
              size="icon"
              variant="ghost"
            >
              <X size={12} />
            </Button>
          ) : null}
        </div>
        <Button
          aria-label={t("directory.refreshTree")}
          busy={initialLoading && listed}
          className="rounded-sm border border-line text-ink-muted hover:bg-control-ghost-hover hover:text-ink"
          onClick={() => loadDirectory()}
          size="icon"
          title={t("directory.refresh")}
          variant="ghost"
        >
          <RefreshCw size={13} />
        </Button>
      </div>

      {rootPath ? (
        <div
          className="flex items-center border-b border-line bg-control-ghost-hover px-3.5 py-1.5 font-mono text-2xs text-ink-faint"
          title={rootPath}
        >
          <span className="truncate">{rootPath}</span>
        </div>
      ) : null}

      <div
        aria-busy={initialLoading || undefined}
        className="flex-1 overflow-y-auto py-1.5"
      >
        {initialLoading && !listed ? (
          <Skeleton
            compact
            label={t("directory.loading")}
            rows={8}
            variant="items"
          />
        ) : error ? (
          <div className="p-3">
            <Alert
              actions={
                <Button
                  onClick={() => loadDirectory()}
                  size="sm"
                  variant="secondary"
                >
                  {t("common:actions.retry")}
                </Button>
              }
              size="compact"
              title={error}
              tone="error"
            />
          </div>
        ) : filteredRootEntries.length === 0 ? (
          <div className={centeredMessage}>
            {filterText
              ? t("directory.noMatches", { query: filterText })
              : t("directory.empty")}
          </div>
        ) : (
          <div
            className="flex flex-col"
            aria-label={t("detail.kind.workspaceFile")}
          >
            {filteredRootEntries.map((entry) => (
              <TreeNode
                depth={0}
                entry={entry}
                expandedPaths={expandedPaths}
                filterQuery={filterText}
                folderChildren={folderChildren}
                key={entry.id || entry.path}
                loadingPaths={loadingPaths}
                onSelectFile={onSelectFile}
                onToggleFolder={toggleFolder}
                selectedPath={selectedPath}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
