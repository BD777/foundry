import { FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceDirectoryEntry } from "@bd777/foundry-protocol";
import { listWorkspaceSubdirectories } from "../../api";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from "../ui/command";
import { fieldVariants } from "../ui/field";
import {
  matchesFolderQuery,
  workspacePathLookup,
} from "./workspace-path-lookup";
import { LoadingState } from "../ui/loading";

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
  const { t } = useTranslation("workspaces");
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

  // Closes after a click outside completes, not on pointerdown: the list sits
  // in the dialog's flow, so closing it moves the footer, and a button that
  // moves between press and release never receives the click.
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
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
      className="group/picker min-w-0 rounded-none bg-transparent"
      data-navigated={navigated}
      label={t("pathPicker.label")}
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
      <CommandInput
        aria-label={t("pathPicker.label")}
        className={fieldVariants({ tone: "boxed" })}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onValueChange={(next) => {
          onChange(next);
          setNavigated(false);
          setOpen(true);
        }}
        placeholder={t("pathPicker.placeholder")}
        ref={inputRef}
        required
        value={value}
      />
      {showList ? (
        <CommandList className="mt-1.5 max-h-59 rounded-md bg-surface p-1.5 shadow-floating">
          {loading && suggestions.length === 0 ? (
            <CommandLoading className="px-[9px] py-2 text-xs text-ink-muted">
              <LoadingState label={t("pathPicker.loading")} />
            </CommandLoading>
          ) : null}
          {suggestions.map((folder) => (
            <CommandItem
              className="gap-[9px] rounded-sm px-[9px] py-2 hover:bg-control-ghost-hover data-[selected=true]:bg-transparent group-data-[navigated=true]/picker:data-[selected=true]:bg-control-ghost-hover"
              key={folder.path}
              onSelect={() => pick(folder.path)}
              value={folder.path}
            >
              <FolderOpen
                className="flex-none text-warning-text"
                size={13}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <strong className="block min-w-0 truncate text-xs leading-[1.25] font-semibold text-ink">
                  {folder.name}
                </strong>
                <em className="block min-w-0 truncate font-mono text-2xs leading-[1.25] text-ink-muted not-italic">
                  {folder.path}
                </em>
              </span>
            </CommandItem>
          ))}
        </CommandList>
      ) : null}
    </Command>
  );
}
