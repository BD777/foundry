import type { ChatsChangedPayload } from "@bd777/foundry-protocol";
import type { FoundryData } from "../../api-types";
import {
  eachPayload,
  type LoadedMerges,
  type StreamProjections,
} from "./stream-projection";

/** Chats of the chat list the stream sent or removed. */
export const chatTouchKinds = ["chats"] as const;

/** A chats_changed event applied to the chat list of its workspace. */
function applyChatChanges(
  data: FoundryData,
  { workspaceId, chats: changed, removed }: ChatsChangedPayload,
): FoundryData {
  if (workspaceId !== data.workspace.id) return data;
  const gone = new Set(removed);
  const incoming = new Map(changed.map((chat) => [chat.id, chat]));
  const next = data.chats
    .filter((chat) => !gone.has(chat.id))
    .map((chat) => {
      const replaced = incoming.get(chat.id);
      if (replaced) incoming.delete(chat.id);
      return replaced ?? chat;
    });
  return {
    ...data,
    chats: incoming.size > 0 ? [...incoming.values(), ...next] : next,
  };
}

export const chatProjections = {
  chats_changed: {
    apply: eachPayload(applyChatChanges),
    touches: (payload) => [
      ...payload.chats.map((chat) => ["chats", chat.id] as const),
      ...payload.removed.map((id) => ["chats", id] as const),
    ],
  },
} satisfies StreamProjections;

/**
 * Like keepStreamed for a list the stream also removes from: a chat the
 * stream sent or removed after the read started stays as shown, present or
 * not.
 */
function keepStreamedChats<T extends { id: string }>(
  current: readonly T[],
  loaded: T[],
  touched: ReadonlySet<string> = new Set(),
): T[] {
  if (touched.size === 0) return loaded;
  const shown = new Map(current.map((item) => [item.id, item]));
  const result = loaded.flatMap((item) => {
    if (!touched.has(item.id)) return [item];
    const kept = shown.get(item.id);
    return kept ? [kept] : [];
  });
  const listed = new Set(loaded.map((item) => item.id));
  const added = current.filter(
    (item) => touched.has(item.id) && !listed.has(item.id),
  );
  return added.length > 0 ? [...added, ...result] : result;
}

export const chatLoadedMerges = {
  chats: (current, loaded, touched) =>
    keepStreamedChats(current.chats, loaded.chats, touched?.chats),
} satisfies LoadedMerges;
