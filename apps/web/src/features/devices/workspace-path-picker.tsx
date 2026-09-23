import { Command } from "cmdk";
import { FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import type { WorkspaceDirectoryEntry } from "@foundry/protocol";
import { listWorkspaceSubdirectories } from "../../api";
import { fieldVariants } from "../../components/ui/field";
import {
  matchesFolderQuery,
  workspacePathLookup,
} from "./workspace-path-lookup";

/**
 * Folder path input that suggests folders on the device as you type. Picking
 * a suggestion drills into it; the typed path is what gets registered.
 */
export function WorkspacePathPicker({
  deviceId,
  disabled,
  inputRef,
  offline,
  onChange,
  value,
}: {
  deviceId: string;
  disabled: boolean;
  inputRef: Ref<HTMLInputElement>;
  offline: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const lookup = useMemo(() => workspacePathLookup(value), [value]);
  const [folders, setFolders] = useState<WorkspaceDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");
  // Enter drills into a suggestion only after the arrow keys moved to one;
  // otherwise it submits the typed path.
  const [navigated, setNavigated] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const lookupPath = lookup?.lookupPath;

  useEffect(() => {
    if (!lookupPath || offline) {
      setFolders([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      listWorkspaceSubdirectories({ deviceId, path: lookupPath })
        .then((items) => {
          if (!cancelled) setFolders(items);
        })
        .catch(() => {
          if (!cancelled) setFolders([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deviceId, lookupPath, offline]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const suggestions = useMemo(() => {
    if (!lookup) return [];
    const parent: WorkspaceDirectoryEntry[] = lookup.parentPath
      ? [{ id: "directory_parent", name: "..", path: lookup.parentPath }]
      : [];
    return [
      ...parent,
      ...folders.filter((folder) =>
        matchesFolderQuery(folder.name, lookup.query),
      ),
    ];
  }, [folders, lookup]);

  function pick(path: string) {
    onChange(path.endsWith("/") ? path : `${path}/`);
    setNavigated(false);
    setOpen(true);
  }

  const showList =
    open && value.trim() !== "" && (loading || suggestions.length > 0);
  return (
    <Command
      className="fdy-workspace-path-picker"
      data-navigated={navigated}
      label="Workspace folder"
      loop
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          setOpen(true);
          if (!navigated && suggestions.length > 0) {
            // The first arrow press reveals the first (or last) suggestion
            // instead of moving past the one cmdk pre-selects.
            event.preventDefault();
            setNavigated(true);
            const edge = event.key === "ArrowDown" ? 0 : suggestions.length - 1;
            setActive(suggestions[edge]!.path);
          }
        } else if (event.key === "Enter" && !(showList && navigated)) {
          // cmdk would swallow Enter; submit the form with the typed path.
          event.preventDefault();
          event.currentTarget.closest("form")?.requestSubmit();
        } else if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      onValueChange={setActive}
      ref={root}
      shouldFilter={false}
      value={active}
    >
      <Command.Input
        aria-label="Workspace folder"
        className={fieldVariants({ tone: "boxed" })}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onValueChange={(next) => {
          onChange(next);
          setNavigated(false);
          setOpen(true);
        }}
        placeholder="/absolute/path/to/project"
        ref={inputRef}
        required
        value={value}
      />
      {showList ? (
        <Command.List className="fdy-workspace-path-menu">
          {loading && suggestions.length === 0 ? (
            <Command.Loading className="fdy-workspace-path-loading">
              Loading folders…
            </Command.Loading>
          ) : null}
          {suggestions.map((folder) => (
            <Command.Item
              className="fdy-workspace-path-item"
              key={folder.path}
              onSelect={() => pick(folder.path)}
              value={folder.path}
            >
              <FolderOpen size={13} aria-hidden="true" />
              <span>
                <strong>{folder.name}</strong>
                <em>{folder.path}</em>
              </span>
            </Command.Item>
          ))}
        </Command.List>
      ) : null}
    </Command>
  );
}
