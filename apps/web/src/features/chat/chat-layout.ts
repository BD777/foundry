import type { ChatLayout, ChatPlacement } from "@foundry/protocol";
import type { ChatGroupState } from "./chat-group-state";

export interface ChatDropTarget {
  groupId: string;
  chatId?: string;
  edge: "before" | "after";
}

export function emptyChatLayout(): ChatLayout {
  return { revision: 0, groups: [], positions: [] };
}

export function orderedChats<T extends { id: string }>(
  chats: readonly T[],
  layout: ChatLayout,
): T[] {
  const rank = new Map(
    layout.positions.map((item, index) => [item.chatId, index]),
  );
  // Newly discovered sessions stay at the top until their position is saved.
  // Existing manual positions are independent of activity and title changes.
  return [...chats].sort(
    (a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1),
  );
}

export function layoutGroupState(
  layout: ChatLayout,
  collapsed: Record<string, boolean>,
): ChatGroupState {
  return {
    groups: layout.groups.map((group) => ({
      ...group,
      collapsed: collapsed[group.id] === true,
    })),
    membership: Object.fromEntries(
      layout.positions
        .filter((p) => p.groupId)
        .map((p) => [p.chatId, p.groupId]),
    ),
  };
}

export function withKnownChats(
  layout: ChatLayout,
  chatIds: readonly string[],
): ChatLayout {
  const known = new Set(layout.positions.map((p) => p.chatId));
  const added: ChatPlacement[] = [];
  for (const chatId of chatIds) {
    if (known.has(chatId)) continue;
    known.add(chatId);
    added.push({ chatId, groupId: "" });
  }
  return added.length
    ? { ...layout, positions: [...added, ...layout.positions] }
    : layout;
}

export function moveChat(
  layout: ChatLayout,
  chatId: string,
  target: ChatDropTarget,
  chatIds: readonly string[],
): ChatLayout {
  if (
    chatId === target.chatId ||
    (target.groupId && !layout.groups.some((g) => g.id === target.groupId))
  )
    return layout;
  const full = withKnownChats(layout, chatIds);
  if (!full.positions.some((p) => p.chatId === chatId)) return layout;
  const positions = full.positions.filter((p) => p.chatId !== chatId);
  let index = target.chatId
    ? positions.findIndex(
        (p) => p.chatId === target.chatId && p.groupId === target.groupId,
      )
    : positions.findIndex((p) => p.groupId === target.groupId);
  if (target.chatId && index < 0) return layout;
  if (index < 0) index = positions.length;
  else if (target.edge === "after") {
    index = target.chatId
      ? index + 1
      : positions.reduce(
          (last, p, i) => (p.groupId === target.groupId ? i + 1 : last),
          index,
        );
  }
  positions.splice(index, 0, { chatId, groupId: target.groupId });
  return { ...full, positions };
}

export function addChatGroup(
  layout: ChatLayout,
  id: string,
  chatId: string | undefined,
  chatIds: readonly string[],
): ChatLayout {
  const names = new Set(layout.groups.map((g) => g.name));
  let name = "新建分组";
  for (let suffix = 2; names.has(name); suffix++) name = `新建分组 ${suffix}`;
  const next = { ...layout, groups: [{ id, name }, ...layout.groups] };
  return chatId
    ? moveChat(next, chatId, { groupId: id, edge: "before" }, chatIds)
    : next;
}

export function mergeLegacyGroups(
  layout: ChatLayout,
  legacy: ChatGroupState,
): ChatLayout {
  const groupIds = new Set(layout.groups.map((g) => g.id));
  const chatIds = new Set(layout.positions.map((p) => p.chatId));
  const addedGroups = legacy.groups
    .filter((g) => !groupIds.has(g.id))
    .map(({ id, name }) => ({ id, name }));
  const addedPositions = Object.entries(legacy.membership)
    .filter(([id]) => !chatIds.has(id))
    .map(([chatId, groupId]) => ({ chatId, groupId }));
  if (!addedGroups.length && !addedPositions.length) return layout;
  // Existing server choices win; a second browser cannot replay stale local assignments.
  return {
    ...layout,
    groups: [...addedGroups, ...layout.groups],
    positions: [...layout.positions, ...addedPositions],
  };
}
