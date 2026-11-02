export const CHAT_LIST_DEFAULT_WIDTH = 270;
export const CHAT_LIST_MIN_WIDTH = 220;
export const CHAT_LIST_MAX_WIDTH = 640;
const storageKey = "foundry.chatListWidth";

export function chatListMaxWidth(containerWidth: number): number {
  return Math.max(
    CHAT_LIST_MIN_WIDTH,
    Math.min(CHAT_LIST_MAX_WIDTH, containerWidth / 2),
  );
}

export function clampChatListWidth(
  width: number,
  maxWidth = CHAT_LIST_MAX_WIDTH,
): number {
  return Math.round(
    Math.max(
      CHAT_LIST_MIN_WIDTH,
      Math.min(
        maxWidth,
        Number.isFinite(width) ? width : CHAT_LIST_DEFAULT_WIDTH,
      ),
    ),
  );
}

export function storedChatListWidth(): number {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value?.trim()
      ? clampChatListWidth(Number(value))
      : CHAT_LIST_DEFAULT_WIDTH;
  } catch {
    return CHAT_LIST_DEFAULT_WIDTH;
  }
}

export function persistChatListWidth(width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(clampChatListWidth(width)));
  } catch {
    // Resizing still works when storage is unavailable.
  }
}
