import type { ChatDropTarget } from "./chat-layout";

/** A chat row, group header or empty group the list shows, by its height. */
export interface ChatDropSlot {
  top: number;
  bottom: number;
  groupId: string;
  chatId?: string;
}

/**
 * Where a chat dropped at height `y` goes. Only the height counts, so the
 * list's padding, a group's indent and the gaps between groups resolve to
 * the nearest slot like the rows do: a row splits at its middle, a gap or
 * the space below the list goes after the slot above it.
 */
export function chatDropTarget(
  slots: readonly ChatDropSlot[],
  y: number,
): ChatDropTarget | undefined {
  let above: ChatDropSlot | undefined;
  for (const slot of slots) {
    if (y < slot.top) {
      if (!above) return slotTarget(slot, "before");
      break;
    }
    if (y < slot.bottom)
      return slotTarget(
        slot,
        y > slot.top + (slot.bottom - slot.top) / 2 ? "after" : "before",
      );
    above = slot;
  }
  return above && slotTarget(above, "after");
}

function slotTarget(
  slot: ChatDropSlot,
  edge: ChatDropTarget["edge"],
): ChatDropTarget {
  return slot.chatId
    ? { groupId: slot.groupId, chatId: slot.chatId, edge }
    : { groupId: slot.groupId, edge: "before" };
}

/**
 * The slots under `list`, top to bottom: its innermost visible
 * `[data-chat-drop]` elements (a group's content box only when it is empty).
 */
export function chatDropSlots(list: HTMLElement): ChatDropSlot[] {
  const slots: ChatDropSlot[] = [];
  for (const element of list.querySelectorAll<HTMLElement>(
    "[data-chat-drop]",
  )) {
    if (element.querySelector("[data-chat-drop]")) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.height) continue;
    slots.push({
      top: rect.top,
      bottom: rect.bottom,
      groupId: element.dataset.groupId ?? "",
      chatId: element.dataset.chatId,
    });
  }
  return slots;
}
