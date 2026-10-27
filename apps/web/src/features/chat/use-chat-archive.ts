import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSession, ChatThread } from "@bd777/foundry-protocol";
import { toast } from "../../components/ui/toast";
import { i18n } from "../../i18n";
import { archiveBlockerReason } from "./chat-archive-reasons";
import {
  archiveChats,
  listArchivedChats,
  unarchiveChats,
  type ChatArchiveInput,
  type ChatArchiveResult,
} from "../../api";

/** Archive data is separate from the active list, including while it is empty. */
export function useChatArchive(workspaceId: string, active: boolean) {
  const [data, setData] = useState<{
    workspaceId: string;
    chats: ChatThread[];
    sessions: AgentSession[];
  }>({ workspaceId, chats: [], sessions: [] });
  const [overrides, setOverrides] = useState<{
    workspaceId: string;
    hidden: Set<string>;
    restored: Set<string>;
  }>({ workspaceId, hidden: new Set(), restored: new Set() });
  const [undo, setUndo] = useState<ChatArchiveResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mutation = useRef(0);
  const readSequence = useRef(0);
  const current = useRef(workspaceId);
  current.current = workspaceId;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const revision = mutation.current;
      const sequence = ++readSequence.current;
      try {
        const next = await listArchivedChats(workspaceId, { signal });
        if (
          current.current === workspaceId &&
          !signal?.aborted &&
          revision === mutation.current &&
          sequence === readSequence.current
        ) {
          setData({ ...next, workspaceId });
          const archivedIds = new Set(
            [...next.chats, ...next.sessions].map((chat) => chat.id),
          );
          setOverrides((previous) =>
            previous.workspaceId === workspaceId
              ? {
                  ...previous,
                  hidden: new Set(
                    [...previous.hidden].filter((id) => archivedIds.has(id)),
                  ),
                  restored: new Set(
                    [...previous.restored].filter((id) => !archivedIds.has(id)),
                  ),
                }
              : previous,
          );
          setError("");
        }
      } catch (error) {
        if (
          !signal?.aborted &&
          current.current === workspaceId &&
          revision === mutation.current &&
          sequence === readSequence.current
        )
          setError(String(error instanceof Error ? error.message : error));
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    setUndo(undefined);
    if (!active || !workspaceId) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(
      () => void refresh(controller.signal),
      15000,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, workspaceId, refresh]);
  const change = async (
    input: Omit<ChatArchiveInput, "workspaceId">,
    restore = false,
  ) => {
    if (inFlight.current) throw new Error(i18n.t("chat:archive.operationBusy"));
    inFlight.current = true;
    toast.dismiss("chat-archive-error");
    mutation.current += 1;
    setBusy(true);
    setError("");
    try {
      const result = await (restore ? unarchiveChats : archiveChats)({
        ...input,
        workspaceId,
      });
      if (current.current !== workspaceId)
        throw new Error(i18n.t("chat:archive.workspaceChanged"));
      if (result.blockers?.length)
        throw new Error(result.blockers.map(archiveBlockerReason).join("; "));
      const ids = restore
        ? (input.chatIds ?? undo?.archived ?? result.archived ?? [])
        : result.archived;
      setOverrides((previous) => {
        const hidden = new Set(
          previous.workspaceId === workspaceId ? previous.hidden : [],
        );
        const restored = new Set(
          previous.workspaceId === workspaceId ? previous.restored : [],
        );
        ids.forEach((id) => {
          if (restore) {
            hidden.delete(id);
            restored.add(id);
          } else {
            hidden.add(id);
            restored.delete(id);
          }
        });
        return { workspaceId, hidden, restored };
      });
      if (restore) {
        setUndo(undefined);
        toast({
          tone: "success",
          title: i18n.t("chat:archive.restored", { count: ids.length }),
        });
      } else setUndo(result);
      await refresh();
      return result;
    } catch (error) {
      if (current.current === workspaceId)
        toast({
          id: "chat-archive-error",
          tone: "error",
          title: i18n.t("chat:archive.failed"),
          description: error instanceof Error ? error.message : String(error),
        });
      throw error;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const shown =
    data.workspaceId === workspaceId ? data : { chats: [], sessions: [] };
  const hidden = new Set(
    overrides.workspaceId === workspaceId ? overrides.hidden : [],
  );
  [...shown.chats, ...shown.sessions].forEach((chat) => hidden.add(chat.id));
  const restored =
    overrides.workspaceId === workspaceId
      ? overrides.restored
      : new Set<string>();
  restored.forEach((id) => hidden.delete(id));
  return { ...shown, hidden, restored, undo, error, busy, refresh, change };
}
