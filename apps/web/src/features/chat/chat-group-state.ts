export interface ChatGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface ChatGroupState {
  groups: ChatGroup[];
  membership: Record<string, string>;
}

export function emptyChatGroupState(): ChatGroupState {
  return { groups: [], membership: {} };
}

export function loadChatGroups(workspaceId: string): ChatGroupState {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(`foundry.chatGroups.v1:${workspaceId}`) ??
        "null",
    );
    if (!parsed || !Array.isArray(parsed.groups)) return emptyChatGroupState();
    const ids = new Set<string>();
    const groups: ChatGroup[] = [];
    for (const group of parsed.groups) {
      if (
        !group ||
        typeof group.id !== "string" ||
        !group.id ||
        ids.has(group.id) ||
        typeof group.name !== "string" ||
        !group.name.trim()
      )
        continue;
      ids.add(group.id);
      groups.push({
        id: group.id,
        name: group.name.trim().slice(0, 120),
        collapsed: group.collapsed === true,
      });
    }
    const membership =
      parsed.membership &&
      typeof parsed.membership === "object" &&
      !Array.isArray(parsed.membership)
        ? (Object.fromEntries(
            Object.entries(parsed.membership).filter(
              ([, id]) => typeof id === "string" && ids.has(id),
            ),
          ) as Record<string, string>)
        : {};
    return { groups, membership };
  } catch {
    return emptyChatGroupState();
  }
}

export function saveChatGroups(
  workspaceId: string,
  state: ChatGroupState,
): void {
  if (!workspaceId) return;
  try {
    window.localStorage.setItem(
      `foundry.chatGroups.v1:${workspaceId}`,
      JSON.stringify(state),
    );
  } catch {
    // Browser preferences must not block chat navigation.
  }
}

export function createChatGroup(
  state: ChatGroupState,
  id: string,
  chatId?: string,
): ChatGroupState {
  const names = new Set(state.groups.map((group) => group.name));
  let name = "新建分组";
  for (let suffix = 2; names.has(name); suffix++) name = `新建分组 ${suffix}`;
  return {
    groups: [{ id, name, collapsed: false }, ...state.groups],
    membership: chatId
      ? { ...state.membership, [chatId]: id }
      : state.membership,
  };
}

export function moveChatToGroup(
  state: ChatGroupState,
  chatId: string,
  groupId?: string,
): ChatGroupState {
  if (groupId && !state.groups.some((group) => group.id === groupId))
    return state;
  const membership = { ...state.membership };
  if (groupId) membership[chatId] = groupId;
  else delete membership[chatId];
  return { ...state, membership };
}

export function filterChatGroups<T extends { id: string; title: string }>(
  chats: readonly T[],
  state: ChatGroupState,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(search);
  const grouped = new Map(state.groups.map((group) => [group.id, [] as T[]]));
  const ungrouped: T[] = [];
  for (const chat of chats) {
    const groupId = state.membership[chat.id];
    const children = groupId ? grouped.get(groupId) : undefined;
    if (children) children.push(chat);
    else if (matches(chat.title)) ungrouped.push(chat);
  }
  const groups = state.groups
    .map((group) => ({
      ...group,
      chats: (grouped.get(group.id) ?? []).filter(
        (chat) => matches(group.name) || matches(chat.title),
      ),
    }))
    .filter((group) => matches(group.name) || group.chats.length > 0);
  return { groups, ungrouped };
}
