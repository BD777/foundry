import { useEffect, useRef, useState } from "react";
import type { ChatLayout } from "@bd777/foundry-protocol";
import { deleteChatGroup, getChatLayout, saveChatLayout } from "../../api";
import {
  carriedData,
  foundryStreamEpoch,
  foundryStreamOpened,
  onStreamEvent,
} from "../../stream";
import { emptyChatLayout } from "./chat-layout";
import { ChatLayoutSync, type LayoutChange } from "./chat-layout-sync";
import { i18n } from "../../i18n";

function loadCollapsed(workspaceId: string): Record<string, boolean> {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(
        `foundry.chatGroupCollapsed.v1:${workspaceId}`,
      ) ?? "{}",
    );
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      return {};
    return Object.fromEntries(
      Object.entries(stored)
        .filter(([, value]) => typeof value === "boolean")
        .map(([id, value]) => [id, value === true]),
    );
  } catch {
    return {};
  }
}

/**
 * The layouts this tab holds, by workspace, each with the stream epoch it
 * is current at (see foundryStreamEpoch): every later change arrives on the
 * stream, so one current at this epoch is shown without reading it. Kept
 * while something retains them (see retainChatLayouts).
 */
const heldLayouts = new Map<string, { layout: ChatLayout; epoch: number }>();
let layoutRetainers = 0;
let stopLayoutEvents: (() => void) | undefined;

/** Holds a layout unless a newer revision is held; returns the newer. */
function holdLayout(
  workspaceId: string,
  layout: ChatLayout,
  epoch: number,
): ChatLayout {
  const held = heldLayouts.get(workspaceId);
  if (held && held.layout.revision > layout.revision) return held.layout;
  heldLayouts.set(workspaceId, { layout, epoch });
  return layout;
}

function currentLayout(workspaceId: string): ChatLayout | undefined {
  const held = heldLayouts.get(workspaceId);
  return held && held.epoch === foundryStreamEpoch() ? held.layout : undefined;
}

/** Reads the layout; a newer one pushed meanwhile answers instead. */
async function readLayout(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ChatLayout> {
  const epoch = foundryStreamEpoch();
  return holdLayout(
    workspaceId,
    await getChatLayout(workspaceId, { signal }),
    epoch,
  );
}

/** A change the server answered with the layout after it. */
async function changeLayout(
  workspaceId: string,
  request: () => Promise<ChatLayout>,
): Promise<ChatLayout> {
  const epoch = foundryStreamEpoch();
  const layout = await request();
  holdLayout(workspaceId, layout, epoch);
  return layout;
}

/**
 * Keeps the held layouts current from chat_layout_changed: one it carries
 * replaces an older revision, one it does not drops the workspace's. The
 * chat feature retains them for the page's life, so the chat list shows
 * again without a read; once nothing retains them they are dropped, as
 * nothing would tell them stale.
 */
export function retainChatLayouts(): () => void {
  if (layoutRetainers++ === 0)
    stopLayoutEvents = onStreamEvent("chat_layout_changed", (payload) => {
      const layout = carriedData("chat_layout_changed", payload);
      if (layout) holdLayout(payload.workspaceId, layout, foundryStreamEpoch());
      else heldLayouts.delete(payload.workspaceId);
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--layoutRetainers > 0) return;
    stopLayoutEvents?.();
    stopLayoutEvents = undefined;
    heldLayouts.clear();
  };
}

/**
 * The workspace's chat groups and order, kept by the server: read once the
 * stream opened unless held current, then kept from chat_layout_changed;
 * read again when an event does not carry the layout or after a resync.
 * This tab's own changes go through ChatLayoutSync.
 */
export function useChatLayout(workspaceId: string) {
  const [layout, setLayout] = useState(
    () => currentLayout(workspaceId) ?? emptyChatLayout(),
  );
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(workspaceId));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const syncRef = useRef<ChatLayoutSync | undefined>(undefined);
  useEffect(() => {
    const release = retainChatLayouts();
    let active = true;
    let sync: ChatLayoutSync | undefined;
    // The first read waits for the stream to open: it reads after any
    // resync or change meanwhile.
    let waiting = false;
    // A change announced before the first read landed: read once more.
    let changedWhileLoading = false;
    setReady(false);
    setSaving(false);
    setError("");
    const start = async () => {
      let loaded = currentLayout(workspaceId);
      if (!loaded) {
        waiting = true;
        await foundryStreamOpened();
        waiting = false;
        if (!active) return;
        loaded = currentLayout(workspaceId) ?? (await readLayout(workspaceId));
        if (!active) return;
      }
      // A layout pushed while this list started may be newer.
      const held = heldLayouts.get(workspaceId)?.layout;
      if (held && held.revision > loaded.revision) loaded = held;
      setLayout(loaded);
      setReady(true);
      sync = new ChatLayoutSync(loaded, {
        load: (signal) => readLayout(workspaceId, signal),
        save: (next) =>
          changeLayout(workspaceId, () => saveChatLayout(workspaceId, next)),
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
      if (changedWhileLoading) void sync.refresh().catch(() => {});
    };
    // Read again, unless the first read is still waiting to start.
    const changed = () => {
      if (sync) void sync.refresh().catch(() => {});
      else if (!waiting) changedWhileLoading = true;
    };
    const unsubscribe = workspaceId
      ? onStreamEvent(
          "chat_layout_changed",
          (payload) => {
            const pushed = carriedData("chat_layout_changed", payload);
            // Before the list started, a pushed layout is held for it.
            if (!pushed) changed();
            else sync?.apply(pushed);
          },
          // What the list holds predates the resync.
          { workspaceId, onResync: changed },
        )
      : undefined;
    if (workspaceId)
      void start().catch(() => {
        if (active) setError(i18n.t("chat:layoutSync.loadFailed"));
      });
    return () => {
      active = false;
      unsubscribe?.();
      sync?.dispose();
      syncRef.current = undefined;
      release();
    };
  }, [workspaceId, reload]);
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
    retry: () => {
      heldLayouts.delete(workspaceId);
      setReload((value) => value + 1);
    },
    deleteGroup: async (groupId: string) => {
      const sync = syncRef.current;
      if (!ready || !sync) throw new Error(i18n.t("chat:layoutSync.notReady"));
      setDeleting(true);
      try {
        await sync.deleteGroup((revision) =>
          changeLayout(workspaceId, () =>
            deleteChatGroup(workspaceId, groupId, revision),
          ),
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
