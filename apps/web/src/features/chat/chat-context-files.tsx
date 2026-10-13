import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import {
  FileTree,
  type FileTreeItem,
  type FileTreeRoot,
} from "../../components/ui/file-tree";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatSessionFileItem,
} from "./chat-types";

/**
 * Workspace files by their workspace path; others by absolute path. Changes
 * show Git-style A/M/D and their line counts: one turn's, or all turns'.
 */
function fileTreeRoots(
  items: ChatSessionFileItem[],
  changes: { turnId?: string } | undefined,
): FileTreeRoot[] {
  const asItem = (file: ChatSessionFileItem, path: string): FileTreeItem => {
    const status = i18n.t(`chat:contextCard.fileStatus.${file.op}`);
    const lineChanges = changes
      ? changes.turnId
        ? file.turnLineChanges?.[changes.turnId]
        : file.lineChanges
      : undefined;
    return {
      id: file.id,
      path,
      ...(changes && file.op !== "referenced"
        ? {
            status: i18n.t(`chat:contextCard.fileStatusShort.${file.op}`),
            statusLabel: status,
          }
        : { status }),
      ...(lineChanges ? { lineChanges } : {}),
      tone: file.op,
      title: file.path,
    };
  };
  const inside = items.filter((file) => file.workspacePath);
  const outside = items.filter((file) => !file.workspacePath);
  return [
    {
      id: "workspace",
      label: i18n.t("chat:contextCard.workspaceRoot"),
      items: inside.map((file) => asItem(file, file.workspacePath!)),
    },
    {
      id: "outside",
      label: i18n.t("chat:contextCard.outsideRoot"),
      items: outside.map((file) => asItem(file, file.path)),
    },
  ].filter((root) => root.items.length > 0);
}

function FileSection({
  changes,
  emptyLabel,
  files,
  label,
  onSelect,
  reveal,
  title,
}: {
  /** The section lists changes, from one turn (`turnId`) or all of them. */
  changes?: { turnId?: string };
  emptyLabel?: string;
  files: ChatSessionFileItem[];
  label: string;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  title: string;
}) {
  const turnId = changes?.turnId;
  const listsChanges = changes !== undefined;
  const roots = useMemo(
    () => fileTreeRoots(files, listsChanges ? { turnId } : undefined),
    [files, listsChanges, turnId],
  );
  const byId = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files],
  );
  const heading = (inRow: boolean) => (
    <h3 className={inRow ? "fdy-chat-context-heading" : undefined}>
      {title}
      {files.length > 0 ? (
        <span className="fdy-chat-context-count">{files.length}</span>
      ) : null}
    </h3>
  );
  return (
    <section className="fdy-chat-context-section">
      {files.length === 0 ? (
        <>
          {heading(false)}
          <p className="fdy-chat-context-empty">{emptyLabel}</p>
        </>
      ) : (
        <FileTree
          aria-label={label}
          heading={heading(true)}
          onSelect={(item) => {
            const file = byId.get(item.id);
            if (file)
              onSelect?.(turnId ? { ...file, diffTurnId: turnId } : file);
          }}
          reveal={reveal}
          roots={roots}
        />
      )}
    </section>
  );
}

/** Changes and Files: what the chat's tools wrote and its answers named. */
export function SessionFileSections({
  data,
  onClearTurnFilter,
  onSelect,
  reveal,
  turnFilter,
}: {
  data: ChatContextCardData;
  onClearTurnFilter?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  reveal?: { ids: string[] };
  turnFilter?: string;
}) {
  const { t } = useTranslation("chat");
  const inTurn = (file: ChatSessionFileItem) =>
    !turnFilter || file.turnIds.includes(turnFilter);
  const changes = data.changes.filter(inTurn);
  const files = data.files.filter(inTurn);
  return (
    <>
      {turnFilter ? (
        <div className="fdy-chat-context-filter">
          <span>{t("contextCard.turnFilter")}</span>
          <Button onClick={onClearTurnFilter} size="sm" variant="ghost">
            {t("contextCard.showAllFiles")}
          </Button>
        </div>
      ) : null}
      {changes.length + files.length === 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.files")}</h3>
          <p className="fdy-chat-context-empty">
            {t("contextCard.filesEmpty")}
          </p>
        </section>
      ) : (
        <>
          <FileSection
            changes={{ turnId: turnFilter }}
            emptyLabel={t("contextCard.changesEmpty")}
            files={changes}
            label={t("contextCard.changesLabel")}
            onSelect={onSelect}
            reveal={reveal}
            title={t("contextCard.changes")}
          />
          {files.length > 0 ? (
            <FileSection
              files={files}
              label={t("contextCard.filesLabel")}
              onSelect={onSelect}
              reveal={reveal}
              title={t("contextCard.files")}
            />
          ) : null}
        </>
      )}
    </>
  );
}
