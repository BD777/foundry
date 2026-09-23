import { useEffect, useRef, useState } from "react";
import { deleteChatGroup, getChatLayout, saveChatLayout } from "../../api";
import { loadChatGroups } from "./chat-group-state";
import { emptyChatLayout, mergeLegacyGroups } from "./chat-layout";
import { ChatLayoutSync, type LayoutChange } from "./chat-layout-sync";

function loadCollapsed(workspaceId: string): Record<string, boolean> {
  const legacy = Object.fromEntries(
    loadChatGroups(workspaceId).groups.map((g) => [g.id, g.collapsed]),
  );
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(
        `foundry.chatGroupCollapsed.v1:${workspaceId}`,
      ) ?? "{}",
    );
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      return legacy;
    return {
      ...legacy,
      ...Object.fromEntries(
        Object.entries(stored)
          .filter(([, value]) => typeof value === "boolean")
          .map(([id, value]) => [id, value === true]),
      ),
    };
  } catch {
    return legacy;
  }
}

function legacyMigrated(workspaceId: string): boolean {
  try {
    return (
      window.localStorage.getItem(
        `foundry.chatGroupsMigrated.v1:${workspaceId}`,
      ) === "true"
    );
  } catch {
    return false;
  }
}

export function useChatLayout(workspaceId: string, readOnly = false) {
  const [layout, setLayout] = useState(emptyChatLayout);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(workspaceId));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const syncRef = useRef<ChatLayoutSync | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let sync: ChatLayoutSync | undefined;
    setReady(false);
    setSaving(false);
    setError("");
    const start = async () => {
      let loaded = await getChatLayout(workspaceId);
      if (!active) return;
      // Viewers cannot save, so their legacy local groups stay unmigrated.
      if (!readOnly && !legacyMigrated(workspaceId)) {
        const merged = mergeLegacyGroups(loaded, loadChatGroups(workspaceId));
        if (merged !== loaded) {
          // A conflict leaves the legacy copy intact; Retry reads and merges afresh.
          loaded = await saveChatLayout(workspaceId, merged);
          if (!active) return;
        }
        try {
          window.localStorage.setItem(
            `foundry.chatGroupsMigrated.v1:${workspaceId}`,
            "true",
          );
        } catch {
          /* idempotent merge can retry */
        }
      }
      setLayout(loaded);
      setReady(true);
      sync = new ChatLayoutSync(loaded, {
        load: () => getChatLayout(workspaceId),
        save: (next) => saveChatLayout(workspaceId, next),
        changed: (next, pending) => {
          setLayout(next);
          setSaving(pending);
        },
        failed: (message, usable) => {
          setError(message);
          setReady(usable);
        },
      });
      syncRef.current = sync;
    };
    if (workspaceId)
      void start().catch(() => {
        if (active)
          setError("分组加载或迁移失败，请重试；原有本地分组仍保留。");
      });
    const refresh = () => {
      if (document.visibilityState === "visible")
        void sync?.refresh().catch(() => {});
    };
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      sync?.dispose();
      syncRef.current = undefined;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceId, readOnly, reload]);
  useEffect(() => {
    if (!workspaceId) return;
    try {
      window.localStorage.setItem(
        `foundry.chatGroupCollapsed.v1:${workspaceId}`,
        JSON.stringify(collapsed),
      );
    } catch {
      /* local preference only */
    }
  }, [collapsed, workspaceId]);
  return {
    layout,
    collapsed,
    ready: ready && !deleting,
    saving,
    error,
    retry: () => setReload((value) => value + 1),
    deleteGroup: async (groupId: string) => {
      const sync = syncRef.current;
      if (!ready || !sync) throw new Error("请等待分组加载完成。");
      setDeleting(true);
      try {
        await sync.deleteGroup((revision) =>
          deleteChatGroup(workspaceId, groupId, revision),
        );
      } catch (error) {
        await sync.refresh().catch(() => {});
        throw error;
      } finally {
        setDeleting(false);
      }
    },
    change: (change: LayoutChange) => {
      if (!ready) return;
      setError("");
      syncRef.current?.enqueue(change);
    },
    toggle: (id: string) =>
      setCollapsed((current) => ({ ...current, [id]: !current[id] })),
    expand: (id: string) =>
      setCollapsed((current) => ({ ...current, [id]: false })),
  };
}
