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
  /** The person is scrolling now: wheel, touch, keys or the scrollbar. */
  personScrolling: () => boolean;
  readHistory: () => void;
  /** The person moved away from the latest content themselves. */
  readingHistory: () => boolean;
  showScrollToLatest: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
}

const scrollKeys = [
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
];

function viewportMetrics(viewport: HTMLElement): ChatViewportMetrics {
  return {
    clientHeight: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
  };
}

function scrollViewportToLatest(
  viewport: HTMLElement,
  behavior: ScrollBehavior,
): void {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const effectiveBehavior = chatEffectiveScrollBehavior(
    behavior,
    viewportMetrics(viewport),
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
}

/** A scroll key meant for the transcript, not for a field or another pane. */
function keyScrollsViewport(
  event: KeyboardEvent,
  viewport: HTMLElement,
): boolean {
  if (!scrollKeys.includes(event.key)) {
    return false;
  }
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  ) {
    return false;
  }
  const activeElement = document.activeElement;
  const scrollRoot = viewport.parentElement;
  const documentOwnsFocus =
    target === document.body || target === document.documentElement;
  return (
    documentOwnsFocus ||
    viewport.matches(":hover") ||
    (activeElement !== null &&
      (viewport.contains(activeElement) ||
        Boolean(scrollRoot?.contains(activeElement))))
  );
}

interface UserScrollInput {
  /** When the person last scrolled with wheel, touch, keys or the scrollbar. */
  at: number;
  scrollbarHeld: boolean;
}

/**
 * Tells the follow mode about the person's scrolling of `viewport`: wheel,
 * touch, keys and its scrollbar. Returns the cleanup.
 */
function watchViewportScrolling(
  viewport: HTMLElement,
  input: UserScrollInput,
  transition: (event: ChatScrollFollowEvent) => ChatScrollFollowMode,
  personScrolling: () => boolean,
): () => void {
  // Scrolls within this window of the person's own input, or while they
  // hold the scrollbar, are theirs; any other scroll comes from content
  // resizing and must not resume following.
  const userInput = (): void => {
    input.at = performance.now();
  };
  const markHistoryReading = (): void => {
    userInput();
    transition({ type: "user.scroll-intent" });
  };
  let lastScrollTop = viewport.scrollTop;
  const syncFollowFromPosition = (): void => {
    const metrics = viewportMetrics(viewport);
    const towardLatest = metrics.scrollTop > lastScrollTop;
    lastScrollTop = metrics.scrollTop;
    transition(
      personScrolling()
        ? { towardLatest, type: "user.scrolled", viewport: metrics }
        : { type: "viewport.scrolled", viewport: metrics },
    );
  };
  const handleWheel = (event: WheelEvent): void => {
    if (
      event.deltaY < 0 ||
      (event.deltaY !== 0 && !chatViewportIsAtLatest(viewportMetrics(viewport)))
    ) {
      markHistoryReading();
    } else if (event.deltaY > 0) {
      // Scrolling down while already at the bottom moves nothing, so no
      // scroll event follows; the intent alone resumes following.
      userInput();
      transition({
        towardLatest: true,
        type: "user.scrolled",
        viewport: viewportMetrics(viewport),
      });
    }
  };
  const handlePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    const outside = target instanceof Node && !viewport.contains(target);
    if (event.button === 1 || outside) {
      markHistoryReading();
    }
    // A press on the viewport itself, not its content, is its scrollbar.
    if (target === viewport || outside) {
      input.scrollbarHeld = true;
    }
  };
  const handlePointerUp = (): void => {
    if (input.scrollbarHeld) userInput();
    input.scrollbarHeld = false;
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (keyScrollsViewport(event, viewport)) markHistoryReading();
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
}

export function useChatScrollFollow(
  threadKey: string,
): ChatScrollFollowController {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<ChatScrollFollowMode>("following");
  const scrollFrameRef = useRef<number | null>(null);
  const userInputRef = useRef<UserScrollInput>({
    at: -Infinity,
    scrollbarHeld: false,
  });
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
    if (viewport) scrollViewportToLatest(viewport, behavior);
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

  // Scrolls within this window of the person's own input, or while they hold
  // the scrollbar, are theirs.
  const personScrolling = useCallback((): boolean => {
    const input = userInputRef.current;
    return input.scrollbarHeld || performance.now() - input.at < 300;
  }, []);

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

  const readingHistory = useCallback(
    (): boolean => modeRef.current === "reading",
    [],
  );

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
    return watchViewportScrolling(
      viewport,
      userInputRef.current,
      transition,
      personScrolling,
    );
  }, [personScrolling, threadKey, transition]);

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
    personScrolling,
    readHistory,
    readingHistory,
    showScrollToLatest,
    viewportRef,
  };
}
