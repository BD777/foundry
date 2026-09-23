import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatIsUnread,
  loadChatReadState,
  saveChatReadState,
} from "./chat-list-state";
import {
  listChatTitles,
  recapChatTitle,
  renameChat,
  type ChatTitleMetadata,
} from "../../api";

export function useChatReadState(
  workspaceId: string,
  active: boolean,
  selectedId: string,
  revision: string,
) {
  const [bucket, setBucket] = useState(() => ({
    workspaceId,
    entries: loadChatReadState(workspaceId),
  }));
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  const lastViewRef = useRef("");
  useEffect(() => {
    setBucket({ workspaceId, entries: loadChatReadState(workspaceId) });
  }, [workspaceId]);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const read = useCallback(
    (id: string, answer: string, explicit = true) => {
      setBucket((current) => {
        if (current.workspaceId !== workspaceId) return current;
        const previous = current.entries[id];
        if (!explicit && previous?.forced) return current;
        if (previous?.revision === answer && !previous.forced) return current;
        return {
          ...current,
          entries: { ...current.entries, [id]: { revision: answer } },
        };
      });
    },
    [workspaceId],
  );
  useEffect(() => {
    if (bucket.workspaceId !== workspaceId) return;
    const view =
      active && visible && selectedId ? `${workspaceId}:${selectedId}` : "";
    const entering = view !== lastViewRef.current;
    lastViewRef.current = view;
    if (view) read(selectedId, revision, entering);
  }, [active, visible, selectedId, revision, read, bucket.workspaceId]);
  useEffect(() => {
    if (workspaceId && bucket.workspaceId === workspaceId)
      saveChatReadState(workspaceId, bucket.entries);
  }, [workspaceId, bucket]);
  return {
    read,
    unread: (id: string, answer: string) =>
      chatIsUnread(
        bucket.workspaceId === workspaceId ? bucket.entries[id] : undefined,
        answer,
      ),
    markUnread: (id: string) =>
      setBucket((current) =>
        current.workspaceId === workspaceId
          ? {
              ...current,
              entries: {
                ...current.entries,
                [id]: {
                  revision: current.entries[id]?.revision ?? "",
                  forced: true,
                },
              },
            }
          : current,
      ),
  };
}

export function useChatTitles(
  workspaceId: string,
  active: boolean,
  generationRevision: string,
  notify: (message: string) => void,
) {
  const [bucket, setBucket] = useState<{
    workspaceId: string;
    items: Record<string, ChatTitleMetadata>;
  }>({ workspaceId, items: {} });
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const requestRef = useRef(0);
  const watchedJobsRef = useRef(new Set<string>());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const request = ++requestRef.current;
    const titles = await listChatTitles(workspaceId);
    for (const title of titles) {
      if (!title.generationSessionId) continue;
      if (["queued", "running"].includes(title.generationStatus ?? ""))
        watchedJobsRef.current.add(title.generationSessionId);
      else if (
        title.generationStatus === "failed" &&
        watchedJobsRef.current.delete(title.generationSessionId) &&
        workspaceRef.current === workspaceId
      )
        notifyRef.current(
          title.generationError || "自动命名失败，请重试或手动重命名",
        );
    }
    if (workspaceRef.current === workspaceId && request === requestRef.current)
      setBucket({
        workspaceId,
        items: Object.fromEntries(titles.map((title) => [title.chatId, title])),
      });
  }, [workspaceId]);
  useEffect(() => {
    if (!active) return;
    void refresh().catch(() => {});
    const timer = window.setInterval(
      () => void refresh().catch(() => {}),
      10000,
    );
    return () => window.clearInterval(timer);
  }, [active, refresh, generationRevision]);
  const rename = useCallback(
    async (id: string, title: string) => {
      const result = await renameChat(id, workspaceId, title);
      ++requestRef.current;
      if (workspaceRef.current === workspaceId)
        setBucket((current) => ({
          workspaceId,
          items: {
            ...(current.workspaceId === workspaceId ? current.items : {}),
            [result.chatId]: result,
          },
        }));
    },
    [workspaceId],
  );
  const recap = useCallback(
    async (id: string) => {
      try {
        const job = await recapChatTitle(id, workspaceId);
        watchedJobsRef.current.add(job.id);
        await refresh();
        notifyRef.current("正在用此会话的 provider 生成标题…");
      } catch (error) {
        notifyRef.current(
          error instanceof Error ? error.message : "自动命名失败",
        );
      }
    },
    [workspaceId, refresh],
  );
  return {
    titles: bucket.workspaceId === workspaceId ? bucket.items : {},
    rename,
    recap,
  };
}
