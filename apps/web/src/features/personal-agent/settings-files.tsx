import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ChevronDown,
  FilePlus,
  FolderClosed,
  House,
} from "lucide-react";
import type { AssistantWorkspace } from "@bd777/foundry-protocol";
import { listAssistantWorkspaces, saveAssistantFile } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { FieldHint, TextInput } from "../../components/ui/field";
import { FormField } from "../../components/ui/form-field";
import { Skeleton } from "../../components/ui/loading";
import {
  DropdownMenuEntry,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from "../../components/ui/row-menu-parts";
import { ToastFeedback } from "../../components/ui/toast";
import {
  unopenableLink,
  WorkspaceDirectoryBrowser,
  type WorkspaceTreeSelection,
} from "../../components/workspace/workspace-directory-browser";
import { cn } from "../../lib/cn";
import { serverErrorText } from "../../lib/errors";
import { PaMuted } from "./pa-muted";
import { FileEditor } from "./settings-file-editor";
import { folderOf } from "./settings-file-history";

function workspaceLabel(
  workspace: AssistantWorkspace,
  t: ReturnType<typeof useTranslation<"personalAgent">>["t"],
): string {
  return workspace.kind === "home"
    ? t("settings.files.home")
    : t("settings.files.channel", {
        name: workspace.channelName || workspace.name,
      });
}

/**
 * The files of every workspace the assistant runs in (DEV-223): its home
 * and each message channel's workspace, as a tree beside the open file,
 * which the person reads, edits, renames, deletes and restores.
 */
export function FilesSection({
  assistantId,
  initialWorkspaceId,
  onNotice,
}: {
  assistantId?: string;
  /** The workspace to open first (a channel's, from its row). */
  initialWorkspaceId?: string;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [workspaces, setWorkspaces] = useState<AssistantWorkspace[]>();
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [path, setPathOnly] = useState<string>();
  // How the open entry was listed: a link out of the workspace (or a broken
  // one) is explained, never opened in the editor.
  const [link, setLink] = useState<WorkspaceTreeSelection["link"]>();
  const setPath = (next: string | undefined) => {
    setPathOnly(next);
    setLink(undefined);
  };
  const [treeVersion, setTreeVersion] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    listAssistantWorkspaces(assistantId).then(
      (list) => {
        if (cancelled) return;
        setWorkspaces(list.workspaces);
        setWorkspaceId((current) =>
          list.workspaces.some((workspace) => workspace.id === current)
            ? current
            : list.workspaces[0]?.id,
        );
      },
      (reason: unknown) => {
        if (!cancelled) setLoadError(serverErrorText(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assistantId, attempt]);

  useEffect(() => {
    if (initialWorkspaceId) {
      setWorkspaceId(initialWorkspaceId);
      setPath(undefined);
    }
  }, [initialWorkspaceId]);

  if (loadError)
    return (
      <Alert
        actions={
          <Button onClick={() => setAttempt((value) => value + 1)} size="sm">
            {t("settings.files.retry")}
          </Button>
        }
        size="compact"
        title={t("settings.files.loadFailed")}
        tone="error"
      >
        {loadError}
      </Alert>
    );
  if (!workspaces)
    return <Skeleton className="h-64" label={t("settings.files.tree")} />;
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace)
    return <PaMuted size="xs">{t("settings.files.noWorkspaces")}</PaMuted>;

  const refreshTree = () => setTreeVersion((value) => value + 1);
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <WorkspaceSwitcher
          current={workspace}
          onSelect={(id) => {
            setWorkspaceId(id);
            setPath(undefined);
          }}
          workspaces={workspaces}
        />
        <span
          className="min-w-0 truncate font-mono text-xs text-ink-muted"
          title={workspace.path}
        >
          {t("settings.files.where", {
            device: workspace.deviceName || workspace.deviceId,
            path: workspace.path,
          })}
        </span>
      </div>
      <PaMuted size="xs">
        {workspace.kind === "home"
          ? t("settings.files.writers.home")
          : t("settings.files.writers.channel", {
              name: workspace.channelName || workspace.name,
            })}
      </PaMuted>
      {workspace.connected ? null : (
        <Alert
          size="compact"
          title={t("settings.files.offline", {
            device: workspace.deviceName || workspace.deviceId,
          })}
          tone="warning"
        />
      )}
      <div className="grid min-h-[34rem] min-w-0 overflow-hidden rounded-lg border border-line bg-surface lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]">
        <div
          className={cn(
            "flex min-h-[34rem] min-w-0 flex-col border-line lg:border-r",
            path !== undefined && "max-lg:hidden",
          )}
        >
          <div className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-1.5 pr-1.5 pl-3.5">
            <span className="text-xs font-semibold text-ink-muted">
              {t("settings.files.tree")}
            </span>
            <Button
              disabled={!workspace.connected || !workspace.canWrite}
              onClick={() => setCreating(true)}
              size="sm"
              variant="ghost"
            >
              <FilePlus aria-hidden="true" size={14} />
              {t("settings.files.newFile")}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <WorkspaceDirectoryBrowser
              key={`${workspace.id}:${treeVersion}`}
              onSelectFile={(file) => {
                setPathOnly(file.path);
                setLink(file.link);
              }}
              selectedPath={path}
              workspaceId={workspace.id}
            />
          </div>
        </div>
        <div className={cn("min-w-0", path === undefined && "max-lg:hidden")}>
          {path === undefined ? (
            <div className="flex h-full min-h-40 items-center justify-center p-6 text-center text-sm text-ink-muted">
              {t("settings.files.pick")}
            </div>
          ) : unopenableLink({ link }) ? (
            <LinkNotice
              link={link}
              onBack={() => setPath(undefined)}
              path={path}
            />
          ) : (
            <FileEditor
              assistantId={assistantId}
              key={`${workspace.id}:${path}`}
              onBack={() => setPath(undefined)}
              onDeleted={() => {
                setPath(undefined);
                refreshTree();
              }}
              onNotice={onNotice}
              onRenamed={(to) => {
                setPath(to);
                refreshTree();
              }}
              onSaved={refreshTree}
              path={path}
              workspace={workspace}
            />
          )}
        </div>
      </div>
      <NewFileDialog
        assistantId={assistantId}
        folder={path ? folderOf(path) : ""}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setPath(created);
          refreshTree();
        }}
        open={creating}
        workspaceId={workspace.id}
      />
    </div>
  );
}

/** A link out of the workspace, or a broken one: said plainly, not opened. */
function LinkNotice({
  link,
  onBack,
  path,
}: {
  link: WorkspaceTreeSelection["link"];
  onBack: () => void;
  path: string;
}) {
  const { t } = useTranslation("chat");
  const { t: tp } = useTranslation("personalAgent");
  const kind = link === "missing" ? "missing" : "outside";
  const name = path.split("/").pop() || path;
  return (
    <article className="grid min-w-0 content-start gap-4 p-4">
      <Button
        className="justify-self-start lg:hidden"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft aria-hidden="true" size={14} />
        {tp("settings.files.backToTree")}
      </Button>
      <h4
        className="min-w-0 truncate font-mono text-sm font-semibold text-ink"
        title={path}
      >
        {path}
      </h4>
      <Alert
        size="compact"
        title={t(`directory.linkNotice.${kind}Title`)}
        tone={kind === "missing" ? "warning" : "info"}
      >
        {t(`directory.linkNotice.${kind}Body`, { name })}
      </Alert>
    </article>
  );
}

/** The title dropdown that switches between the assistant's workspaces. */
function WorkspaceSwitcher({
  current,
  onSelect,
  workspaces,
}: {
  current: AssistantWorkspace;
  onSelect: (workspaceId: string) => void;
  workspaces: AssistantWorkspace[];
}) {
  const { t } = useTranslation("personalAgent");
  const label = t("settings.files.switcher");
  const name = workspaceLabel(current, t);
  const icon = (workspace: AssistantWorkspace) =>
    workspace.kind === "home" ? (
      <House aria-hidden="true" size={15} />
    ) : (
      <FolderClosed aria-hidden="true" size={15} />
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${label}: ${name}`}
          className="h-auto min-w-0 max-w-full justify-start gap-1.5 rounded-sm px-0 py-0 text-left text-md leading-tight font-semibold whitespace-normal wrap-anywhere text-ink active:scale-100"
          title={current.name}
          variant="ghost"
        >
          <span className="min-w-0">{name}</span>
          <ChevronDown
            aria-hidden="true"
            className="flex-none text-ink-muted"
            size={16}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSurface
          align="start"
          aria-label={label}
          className="min-w-[260px]"
          side="bottom"
        >
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {workspaces.map((workspace) => (
            <DropdownMenuEntry
              icon={icon(workspace)}
              key={workspace.id}
              onSelect={() => onSelect(workspace.id)}
              reason={workspace.deviceName || workspace.deviceId}
              selected={workspace.id === current.id}
            >
              {workspaceLabel(workspace, t)}
            </DropdownMenuEntry>
          ))}
        </DropdownMenuSurface>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}

/** Asks for a path and creates an empty text file there. */
function NewFileDialog({
  assistantId,
  folder,
  onClose,
  onCreated,
  open,
  workspaceId,
}: {
  assistantId?: string;
  folder: string;
  onClose: () => void;
  onCreated: (path: string) => void;
  open: boolean;
  workspaceId: string;
}) {
  const { t } = useTranslation("personalAgent");
  const [value, setValue] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setValue(folder);
      setError("");
    }
  }, [open, folder]);
  async function create(): Promise<void> {
    const target = value.trim();
    if (!target || target.endsWith("/")) return;
    setBusy(true);
    setError("");
    try {
      await saveAssistantFile(assistantId, {
        workspaceId,
        path: target,
        content: "",
        baseSha256: "",
      });
      onCreated(target);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {t("settings.files.cancel")}
          </Button>
          <Button
            busy={busy}
            disabled={busy || !value.trim() || value.trim().endsWith("/")}
            onClick={() => void create()}
            variant="primary"
          >
            {t("settings.files.newAction")}
          </Button>
        </>
      }
      layout="compact"
      onClose={onClose}
      open={open}
      title={t("settings.files.newTitle")}
    >
      <FormField>
        <span>{t("settings.files.newLabel")}</span>
        <TextInput
          autoFocus
          className="font-mono"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
          spellCheck={false}
          tone="boxed"
          value={value}
        />
        <FieldHint>{t("settings.files.newHint")}</FieldHint>
      </FormField>
      {error ? (
        <ToastFeedback title={t("settings.files.actionFailed")} tone="error">
          {error}
        </ToastFeedback>
      ) : null}
    </Dialog>
  );
}
