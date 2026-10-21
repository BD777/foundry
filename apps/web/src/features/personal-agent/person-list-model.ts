import type {
  PersonalAgentListItem,
  PersonalAgentListItemInput,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";

// The person's list (docs/personal-agent.md §6) as the home page shows it:
// what is still to do, and what they finished today, in the browser's day.

/** The start of `now`'s day in the browser's time zone. */
export function startOfLocalDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * "To do" and "Done today", each in the server's order (oldest first).
 * Dropped items, and items done before today, are not shown.
 */
export function personListView(
  items: PersonalAgentListItem[],
  now = new Date(),
): { open: PersonalAgentListItem[]; doneToday: PersonalAgentListItem[] } {
  const dayStart = startOfLocalDay(now).getTime();
  return {
    open: items.filter((item) => item.status === "open"),
    doneToday: items.filter((item) => {
      if (item.status !== "done" || !item.closedAt) return false;
      const closed = Date.parse(item.closedAt);
      return Number.isFinite(closed) && closed >= dayStart;
    }),
  };
}

/** When Foundry reminds the person: only for an open item with a known time. */
export function reminderAt(item: PersonalAgentListItem): string | undefined {
  if (item.status !== "open" || !item.remind || !item.at) return undefined;
  return Number.isFinite(Date.parse(item.at)) ? item.at : undefined;
}

/** The assistant's task helping with an item, when it can be opened. */
export function helpingTask(
  item: PersonalAgentListItem,
  tasks: PersonalAgentTask[],
): (PersonalAgentTask & { sessionId: string }) | undefined {
  if (!item.taskId) return undefined;
  const task = tasks.find((candidate) => candidate.id === item.taskId);
  return task?.sessionId
    ? (task as PersonalAgentTask & { sessionId: string })
    : undefined;
}

/**
 * The fields an edit changed, trimmed: an unchanged `when` is not sent,
 * since changing it clears the item's time and reminder.
 */
export function listItemEdit(
  item: PersonalAgentListItem,
  draft: { text: string; when: string },
): PersonalAgentListItemInput {
  const input: PersonalAgentListItemInput = {
    ...(item.revision ? { revision: item.revision } : {}),
  };
  const text = draft.text.trim();
  const when = draft.when.trim();
  if (text && text !== item.text) input.text = text;
  if (when !== (item.when ?? "")) input.when = when;
  return input;
}
