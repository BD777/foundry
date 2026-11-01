export interface ChatGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface ChatGroupState {
  groups: ChatGroup[];
  membership: Record<string, string>;
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
