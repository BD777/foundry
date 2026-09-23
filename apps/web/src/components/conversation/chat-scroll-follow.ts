export const CHAT_LATEST_GAP_PX = 24;
const CHAT_PINNED_GAP_PX = 1;

export interface ChatViewportMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export function chatEffectiveScrollBehavior(
  requested: ScrollBehavior,
  viewport: ChatViewportMetrics,
  reduceMotion: boolean,
): ScrollBehavior {
  const distanceToLatest = Math.max(
    0,
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
  );
  return reduceMotion || distanceToLatest > viewport.clientHeight * 2
    ? "auto"
    : requested;
}

export type ChatScrollFollowMode = "following" | "navigating" | "reading";

export type ChatScrollFollowEvent =
  | { type: "content.resized" }
  | { type: "follow.requested" }
  | { type: "history-navigation.requested" }
  | { type: "thread.changed" }
  | { type: "user.scroll-intent" }
  | { type: "viewport.scrolled"; viewport: ChatViewportMetrics };

export function chatViewportIsAtLatest(viewport: ChatViewportMetrics): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    CHAT_LATEST_GAP_PX
  );
}

function chatViewportIsPinnedToLatest(viewport: ChatViewportMetrics): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    CHAT_PINNED_GAP_PX
  );
}

/**
 * Keep content growth separate from user intent.
 *
 * Polling, streaming, image loads, and disclosure changes can all resize the
 * transcript. None of them may resume following after the user starts reading
 * history. Following resumes only through an explicit request or after the
 * viewport actually reaches the latest content again.
 */
export function nextChatScrollFollowMode(
  current: ChatScrollFollowMode,
  event: ChatScrollFollowEvent,
): ChatScrollFollowMode {
  switch (event.type) {
    case "follow.requested":
    case "thread.changed":
      return "following";
    case "history-navigation.requested":
      return "navigating";
    case "user.scroll-intent":
      return "reading";
    case "viewport.scrolled":
      if (current === "navigating") {
        return chatViewportIsPinnedToLatest(event.viewport)
          ? "navigating"
          : "reading";
      }
      // Dynamic-height virtualizers can temporarily clamp the viewport to the
      // bottom while correcting measurements. Never interpret that geometry
      // change as user intent to resume live following.
      return current;
    case "content.resized":
      return current;
  }
}
