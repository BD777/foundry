import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationFileActions,
  ConversationFileReference,
  ConversationToolFrame,
} from "../../components/conversation/conversation-types";
import { i18n } from "../../i18n";
import { workspaceRelativePath } from "../../components/conversation/file-path-candidate";
import { backgroundWorkNote } from "./chat-context-model";
import type { ChatSurfaceProps } from "./chat-surface-types";
import type { ChatSessionFileItem } from "./chat-types";
import { pendingSessionFile } from "./pending-file-references";
import { useChatContextDetail } from "./use-chat-context-detail";
import { useMediaQuery } from "./use-media-query";

/** Where the context rail sits beside the chat (see 90-responsive.css). */
const contextRailQuery = "(min-width: 1361px)";

type ContextPanelInput = Pick<
  ChatSurfaceProps,
  | "agentActive"
  | "backgroundWork"
  | "contextCard"
  | "onContextPanelVisibleChange"
  | "schedule"
  | "threadKey"
  | "workspaceId"
>;

/**
 * The chat's context panel and the detail it opens: whether it shows, which
 * rows it reveals or filters to, and the notes and file links that open it.
 */
export function useChatContextPanel({
  agentActive,
  backgroundWork: runningWork,
  contextCard,
  onContextPanelVisibleChange,
  schedule: heldSchedule,
  threadKey,
  workspaceId,
}: ContextPanelInput) {
  const [open, setOpen] = useState(false);
  const detail = useChatContextDetail(threadKey);
  // An answer's "N files" chip shows only its turn's files.
  const [turnFilter, setTurnFilter] = useState<string>();
  const [reveal, setReveal] = useState<{ ids: string[] }>();
  useEffect(() => {
    setTurnFilter(undefined);
    setReveal(undefined);
  }, [threadKey]);
  const { close: closeDetail, setSelection } = detail;
  // A background task's row changes as it runs; its panel follows it.
  const selection = detail.selection;
  // The screen follows its session's newest frame as it arrives.
  const screen = contextCard?.screen;
  const liveSelection =
    selection?.kind === "background-task"
      ? (contextCard?.background.find((item) => item.id === selection.id) ??
        selection)
      : selection?.kind === "screen" && screen?.id === selection.id
        ? { ...selection, latest: screen.latest }
        : selection;
  // Read at click time: the links stay stable while files stream in.
  const sessionFiles = useRef<ChatSessionFileItem[]>([]);
  sessionFiles.current = [
    ...(contextCard?.changes ?? []),
    ...(contextCard?.files ?? []),
  ];
  // A pending file's panel turns into the file once the session records it.
  const recordedPending =
    selection?.kind === "session-file" && selection.pending
      ? sessionFiles.current.find((item) => item.path === selection.path)
      : undefined;
  useEffect(() => {
    if (recordedPending) setSelection(recordedPending);
  }, [recordedPending, setSelection]);
  const showPanel = useCallback(() => {
    closeDetail();
    setOpen(true);
  }, [closeDetail]);
  // An idle chat whose agent still works: the note names what keeps running
  // and opens the panel on those rows.
  const backgroundWork = useMemo(
    () =>
      agentActive || !runningWork ? undefined : { ...runningWork, taskIds: [] },
    [agentActive, runningWork],
  );
  const backgroundNote = backgroundWork
    ? backgroundWorkNote(backgroundWork)
    : undefined;
  const revealBackgroundWork = useCallback(() => {
    if (!backgroundWork) return;
    setReveal({
      ids: [
        ...(backgroundWork.timerRun ? [backgroundWork.timerRun.id] : []),
        ...backgroundWork.taskIds,
        ...backgroundWork.subagentIds,
      ],
    });
    showPanel();
  }, [backgroundWork, showPanel]);
  // Otherwise timers its agent holds: the note says when it wakes next and
  // opens the panel on them.
  const schedule = agentActive || backgroundNote ? undefined : heldSchedule;
  const timerIds = useMemo(
    () => contextCard?.timers.map((item) => item.id) ?? [],
    [contextCard],
  );
  const revealTimers = useCallback(() => {
    setReveal({ ids: timerIds });
    showPanel();
  }, [timerIds, showPanel]);
  const workspaceRoot = contextCard?.workspaceRoot;
  const deviceFiles = contextCard?.deviceFiles;
  const openFileReference = useCallback(
    (reference: ConversationFileReference) => {
      const recorded = sessionFiles.current.find(
        (item) => item.path === reference.path,
      );
      // A file outside the workspace: read from the device, its owner's.
      if (reference.device) {
        if (!deviceFiles) return;
        setSelection({
          id: `device-file:${reference.path}`,
          kind: "device-file",
          label:
            reference.path.split(/[\\/]/).filter(Boolean).pop() ??
            reference.path,
          path: reference.path,
          deviceId: deviceFiles.deviceId,
          deviceLabel: deviceFiles.deviceLabel,
        });
        return;
      }
      if (reference.kind === "file") {
        // Not recorded yet: the session that named it reads it, or says so.
        if (recorded) setSelection(recorded);
        else if (reference.pending && reference.sessionId)
          setSelection(
            pendingSessionFile(reference, reference.sessionId, workspaceId),
          );
        return;
      }
      const folder = `${reference.path.replace(/\/+$/, "")}/`;
      const held = sessionFiles.current.filter((item) =>
        item.path.startsWith(folder),
      );
      // A folder of the workspace without files of this session (a script
      // wrote them) opens in the workspace browser, read from the device.
      const path = workspaceRoot
        ? workspaceRelativePath(reference.path, workspaceRoot)
        : undefined;
      if (!held.length && path && path !== reference.path) {
        setSelection({
          id: `workspace-path:${reference.path}`,
          kind: "workspace-path",
          label: path.split("/").filter(Boolean).pop() ?? path,
          path,
          detail: reference.path,
          directory: true,
          workspaceId,
        });
        return;
      }
      setTurnFilter(undefined);
      setReveal({ ids: held.map((item) => item.id) });
      showPanel();
    },
    [deviceFiles, setSelection, showPanel, workspaceId, workspaceRoot],
  );
  // A step's screenshot opens the screen on that frame; the panel never
  // opens by itself.
  const openScreen = useCallback(
    (frame: ConversationToolFrame) =>
      setSelection({
        id: `screen:${frame.sessionId}`,
        kind: "screen",
        label: i18n.t(`conversation:process.frameSource.${frame.source}`),
        sessionId: frame.sessionId,
        workspaceId,
        latest: frame,
        // Its session's newest frame: the screen keeps following.
        ...(frame.id === screen?.latest.id ? {} : { frameId: frame.id }),
      }),
    [screen?.latest.id, setSelection, workspaceId],
  );
  const fileActions = useMemo<ConversationFileActions>(
    () => ({
      open: openFileReference,
      openScreen,
      root: workspaceRoot,
      deviceFiles: Boolean(deviceFiles),
      showTurn: (turnId) => {
        setTurnFilter(turnId);
        showPanel();
      },
    }),
    [deviceFiles, openFileReference, openScreen, showPanel, workspaceRoot],
  );
  useEffect(() => setOpen(false), [threadKey]);
  // Wide screens show the panel beside the chat; narrow ones on request.
  const widePanel = useMediaQuery(contextRailQuery);
  const panelVisible = Boolean(
    contextCard && !detail.selection && (widePanel || open),
  );
  useEffect(() => {
    onContextPanelVisibleChange?.(panelVisible);
  }, [onContextPanelVisibleChange, panelVisible]);
  const clearTurnFilter = useCallback(() => setTurnFilter(undefined), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  return {
    /** The panel is opened (narrow screens show it only then). */
    open,
    close,
    toggle,
    detail,
    liveSelection,
    turnFilter,
    clearTurnFilter,
    reveal,
    fileActions,
    backgroundNote,
    revealBackgroundWork,
    schedule,
    revealTimers,
  };
}
