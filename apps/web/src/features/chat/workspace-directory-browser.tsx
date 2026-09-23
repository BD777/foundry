import { useEffect, useMemo, useState } from "react";
import type { WorkspaceTreeEntry } from "@foundry/protocol";
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
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { listWorkspaceTree } from "../../api";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";

export interface WorkspaceDirectoryBrowserProps {
  workspaceId: string;
  rootPath?: string;
  onSelectFile: (file: { name: string; path: string }) => void;
  selectedPath?: string;
}

function fileIconForExtension(extension?: string) {
  const ext = (extension ?? "").toLowerCase().replace(/^\./, "");
  switch (ext) {
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

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      <mark className="fdy-workspace-tree-highlight">{matched}</mark>
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
    <div className="fdy-workspace-tree-node">
      {isDir ? (
        <Button
          aria-expanded={isExpanded}
          className="fdy-workspace-tree-item fdy-workspace-tree-folder"
          data-depth={depthClamped}
          data-expanded={isExpanded ? "true" : "false"}
          data-selected={isSelected ? "true" : "false"}
          onClick={() => onToggleFolder(entry.path)}
          title={entry.path}
          variant="ghost"
        >
          <span className="fdy-workspace-tree-chevron" aria-hidden="true">
            {isLoading ? (
              <LoaderCircle className="fdy-workspace-tree-spinner" size={13} />
            ) : isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </span>
          <span className="fdy-workspace-tree-icon" aria-hidden="true">
            {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </span>
          <span className="fdy-workspace-tree-name">
            <HighlightMatch query={filterQuery} text={entry.name} />
          </span>
        </Button>
      ) : (
        <Button
          aria-pressed={isSelected}
          className="fdy-workspace-tree-item fdy-workspace-tree-file"
          data-depth={depthClamped}
          data-selected={isSelected ? "true" : "false"}
          onClick={() => onSelectFile({ name: entry.name, path: entry.path })}
          title={entry.path}
          variant="ghost"
        >
          <span
            className="fdy-workspace-tree-chevron-placeholder"
            aria-hidden="true"
          />
          <span className="fdy-workspace-tree-icon" aria-hidden="true">
            {fileIconForExtension(entry.extension)}
          </span>
          <span className="fdy-workspace-tree-name">
            <HighlightMatch query={filterQuery} text={entry.name} />
          </span>
          {entry.size !== undefined ? (
            <span className="fdy-workspace-tree-size">
              {formatSize(entry.size)}
            </span>
          ) : null}
        </Button>
      )}

      {isDir && (isExpanded || filterQuery.trim() !== "") ? (
        <div className="fdy-workspace-tree-branch">
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
              className="fdy-workspace-tree-empty-note"
              data-depth={Math.min(depth + 1, 10)}
            >
              空文件夹
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
  workspaceId,
}: WorkspaceDirectoryBrowserProps) {
  const [entries, setEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [folderChildren, setFolderChildren] = useState<
    Map<string, WorkspaceTreeEntry[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filterText, setFilterText] = useState("");

  const loadDirectory = async (path = "", isRefresh = false) => {
    if (!path) {
      setInitialLoading(true);
    } else {
      setLoadingPaths((prev) => new Set(prev).add(path));
    }
    setError(undefined);
    try {
      const items = await listWorkspaceTree({ path, workspaceId });
      if (!path) {
        setEntries(items);
      } else {
        setFolderChildren((prev) => new Map(prev).set(path, items));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (!path) {
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
    setFolderChildren(new Map());
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setFilterText("");
    void loadDirectory("");
  }, [workspaceId]);

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
    <div className="fdy-workspace-browser">
      <div className="fdy-workspace-browser-header">
        <div className="fdy-workspace-browser-search">
          <Search
            aria-hidden="true"
            className="fdy-workspace-browser-search-icon"
            size={14}
          />
          <TextInput
            aria-label="筛选已展开的文件"
            className="fdy-workspace-browser-input"
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="筛选已展开的文件…"
            type="search"
            value={filterText}
          />
          {filterText ? (
            <Button
              aria-label="清除筛选"
              className="fdy-workspace-browser-clear"
              onClick={() => setFilterText("")}
              size="icon"
              variant="ghost"
            >
              <X size={12} />
            </Button>
          ) : null}
        </div>
        <Button
          aria-label="刷新目录树"
          className="fdy-workspace-browser-refresh"
          onClick={() => loadDirectory("")}
          size="icon"
          title="刷新目录"
          variant="ghost"
        >
          <RefreshCw size={13} />
        </Button>
      </div>

      {rootPath ? (
        <div className="fdy-workspace-browser-path" title={rootPath}>
          <span>{rootPath}</span>
        </div>
      ) : null}

      <div className="fdy-workspace-browser-body">
        {initialLoading ? (
          <div className="fdy-workspace-browser-loading">
            <LoaderCircle className="fdy-workspace-tree-spinner" size={16} />
            <span>正在读取工作区目录…</span>
          </div>
        ) : error ? (
          <div className="fdy-workspace-browser-error">
            <p>{error}</p>
            <Button
              onClick={() => loadDirectory("")}
              size="sm"
              variant="secondary"
            >
              重试
            </Button>
          </div>
        ) : filteredRootEntries.length === 0 ? (
          <div className="fdy-workspace-browser-empty">
            {filterText
              ? `未找到与 “${filterText}” 匹配的文件`
              : "工作区目录为空"}
          </div>
        ) : (
          <div className="fdy-workspace-tree-root" aria-label="工作区文件">
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
