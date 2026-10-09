import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  chatEffectiveScrollBehavior,
  chatViewportIsAtLatest,
  nextChatScrollFollowMode,
  type ChatScrollFollowEvent,
  type ChatScrollFollowMode,
  type ChatViewportMetrics,
} from "./chat-scroll-follow";

export interface ChatScrollFollowController {
  contentRef: RefObject<HTMLDivElement | null>;
  contentResized: () => void;
  followLatest: (behavior?: ScrollBehavior) => void;
  readHistory: () => void;
  showScrollToLatest: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
}

export function useChatScrollFollow(
  threadKey: string,
): ChatScrollFollowController {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<ChatScrollFollowMode>("following");
  const scrollFrameRef = useRef<number | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const transition = useCallback(
    (event: ChatScrollFollowEvent): ChatScrollFollowMode => {
      const next = nextChatScrollFollowMode(modeRef.current, event);
      if (next === modeRef.current) return next;
      modeRef.current = next;
      setShowScrollToLatest(next !== "following");
      if (next !== "following" && scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      return next;
    },
    [],
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const effectiveBehavior = chatEffectiveScrollBehavior(
      behavior,
      {
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      },
      reduceMotion,
    );
    if (effectiveBehavior === "auto") {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    viewport.scrollTo({
      behavior: effectiveBehavior,
      top: viewport.scrollHeight,
    });
  }, []);

  const scheduleScrollToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (modeRef.current !== "following") {
        return;
      }
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (modeRef.current === "following") {
          scrollToLatest(behavior);
        }
      });
    },
    [scrollToLatest],
  );

  const contentResized = useCallback((): void => {
    if (transition({ type: "content.resized" }) === "following") {
      scheduleScrollToLatest("auto");
    }
  }, [scheduleScrollToLatest, transition]);

  const followLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      transition({ type: "follow.requested" });
      scrollToLatest(behavior);
    },
    [scrollToLatest, transition],
  );

  const readHistory = useCallback(() => {
    transition({ type: "history-navigation.requested" });
  }, [transition]);

  useLayoutEffect(() => {
    transition({ type: "thread.changed" });
    scrollToLatest("auto");
    scheduleScrollToLatest("auto");
  }, [scheduleScrollToLatest, scrollToLatest, threadKey, transition]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return undefined;
    }
    const viewportMetrics = (): ChatViewportMetrics => ({
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    });
    // Scrolls within this window of the person's own input, or while they
    // hold the scrollbar, are theirs; any other scroll comes from content
    // resizing and must not resume following.
    let lastUserInputAt = -Infinity;
    let scrollbarHeld = false;
    const userInput = (): void => {
      lastUserInputAt = performance.now();
    };
    const markHistoryReading = (): void => {
      userInput();
      transition({ type: "user.scroll-intent" });
    };
    const syncFollowFromPosition = (): void => {
      const byUser = scrollbarHeld || performance.now() - lastUserInputAt < 300;
      transition({
        type: byUser ? "user.scrolled" : "viewport.scrolled",
        viewport: viewportMetrics(),
      });
    };
    const handleWheel = (event: WheelEvent): void => {
      if (
        event.deltaY < 0 ||
        (event.deltaY !== 0 && !chatViewportIsAtLatest(viewportMetrics()))
      ) {
        markHistoryReading();
      } else if (event.deltaY > 0) {
        // Scrolling down while already at the bottom moves nothing, so no
        // scroll event follows; the intent alone resumes following.
        userInput();
        transition({ type: "user.scrolled", viewport: viewportMetrics() });
      }
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        event.button === 1 ||
        (target instanceof Node && !viewport.contains(target))
      ) {
        markHistoryReading();
      }
      // A press on the viewport itself, not its content, is its scrollbar.
      if (
        target === viewport ||
        (target instanceof Node && !viewport.contains(target))
      ) {
        scrollbarHeld = true;
      }
    };
    const handlePointerUp = (): void => {
      if (scrollbarHeld) userInput();
      scrollbarHeld = false;
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "End",
          "Home",
          "PageDown",
          "PageUp",
          " ",
        ].includes(event.key)
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)
      ) {
        return;
      }
      const activeElement = document.activeElement;
      const scrollRoot = viewport.parentElement;
      const documentOwnsFocus =
        target === document.body || target === document.documentElement;
      if (
        documentOwnsFocus ||
        viewport.matches(":hover") ||
        (activeElement !== null &&
          (viewport.contains(activeElement) ||
            Boolean(scrollRoot?.contains(activeElement))))
      ) {
        markHistoryReading();
      }
    };
    const scrollRoot = viewport.parentElement;
    viewport.addEventListener("scroll", syncFollowFromPosition, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchmove", markHistoryReading, {
      passive: true,
    });
    scrollRoot?.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    syncFollowFromPosition();
    return () => {
      viewport.removeEventListener("scroll", syncFollowFromPosition);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchmove", markHistoryReading);
      scrollRoot?.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [threadKey, transition]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(contentResized);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentResized, threadKey]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    },
    [],
  );

  return {
    contentRef,
    contentResized,
    followLatest,
    readHistory,
    showScrollToLatest,
    viewportRef,
  };
}
