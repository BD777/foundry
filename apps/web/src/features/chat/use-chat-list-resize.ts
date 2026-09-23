import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  CHAT_LIST_DEFAULT_WIDTH,
  CHAT_LIST_MAX_WIDTH,
  CHAT_LIST_MIN_WIDTH,
  chatListMaxWidth,
  clampChatListWidth,
  persistChatListWidth,
  storedChatListWidth,
} from "./chat-list-width";

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  preferredWidth: number;
}

/** Imperative layout updates keep pointer movement out of the chat render path. */
export function useChatListResize() {
  const sidebarRef = useRef<HTMLElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const preferredWidthRef = useRef(CHAT_LIST_DEFAULT_WIDTH);
  const maxWidthRef = useRef(CHAT_LIST_MAX_WIDTH);
  const appliedWidthRef = useRef<number | undefined>(undefined);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);

  const applyWidth = useCallback(() => {
    const width = clampChatListWidth(
      preferredWidthRef.current,
      maxWidthRef.current,
    );
    if (appliedWidthRef.current !== width) {
      sidebarRef.current?.style.setProperty(
        "--fdy-chat-list-width",
        `${width}px`,
      );
      resizerRef.current?.setAttribute("aria-valuenow", String(width));
      resizerRef.current?.setAttribute("aria-valuetext", `${width} pixels`);
      appliedWidthRef.current = width;
    }
  }, []);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      cancelFrame();
      const width = clampChatListWidth(
        preferredWidthRef.current,
        maxWidthRef.current,
      );
      if (commit && width !== drag.startWidth) {
        preferredWidthRef.current = width;
        persistChatListWidth(width);
      } else {
        preferredWidthRef.current = drag.preferredWidth;
      }
      applyWidth();
      const resizer = resizerRef.current;
      if (resizer) delete resizer.dataset.active;
      const screen = sidebarRef.current?.parentElement;
      if (screen) delete screen.dataset.listResizing;
      if (resizer?.hasPointerCapture(drag.pointerId))
        resizer.releasePointerCapture(drag.pointerId);
    },
    [applyWidth, cancelFrame],
  );

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const screen = sidebar?.parentElement;
    if (!screen) return;
    preferredWidthRef.current = storedChatListWidth();
    appliedWidthRef.current = undefined;
    const updateBounds = (width: number) => {
      maxWidthRef.current = chatListMaxWidth(width);
      resizerRef.current?.setAttribute(
        "aria-valuemax",
        String(Math.round(maxWidthRef.current)),
      );
      applyWidth();
    };
    updateBounds(screen.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateBounds(entry.contentRect.width);
      if (dragRef.current && !resizerRef.current?.getClientRects().length)
        finishDrag(false);
    });
    observer.observe(screen);
    return () => {
      observer.disconnect();
      finishDrag(false);
      cancelFrame();
    };
  }, [applyWidth, cancelFrame, finishDrag]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (
      dragRef.current ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: appliedWidthRef.current ?? CHAT_LIST_DEFAULT_WIDTH,
      preferredWidth: preferredWidthRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.active = "true";
    const screen = sidebarRef.current?.parentElement;
    if (screen) screen.dataset.listResizing = "true";
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      preferredWidthRef.current = clampChatListWidth(
        drag.startWidth + event.clientX - drag.startX,
        maxWidthRef.current,
      );
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          applyWidth();
        });
      }
    },
    [applyWidth],
  );

  const commitWidth = useCallback(
    (width: number) => {
      const nextWidth = clampChatListWidth(width, maxWidthRef.current);
      if (nextWidth === preferredWidthRef.current) return;
      preferredWidthRef.current = nextWidth;
      applyWidth();
      persistChatListWidth(preferredWidthRef.current);
    },
    [applyWidth],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        finishDrag(false);
        return;
      }
      if (dragRef.current) return;
      const step = event.shiftKey ? 64 : 16;
      const width = appliedWidthRef.current ?? CHAT_LIST_DEFAULT_WIDTH;
      const next =
        event.key === "ArrowLeft"
          ? width - step
          : event.key === "ArrowRight"
            ? width + step
            : event.key === "Home"
              ? CHAT_LIST_MIN_WIDTH
              : event.key === "End"
                ? maxWidthRef.current
                : undefined;
      if (next !== undefined) {
        event.preventDefault();
        commitWidth(next);
      }
    },
    [commitWidth, finishDrag],
  );

  return {
    sidebarRef,
    resizerRef,
    resizeHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerId === dragRef.current?.pointerId) {
          onPointerMove(event);
          finishDrag(true);
        }
      },
      onPointerCancel: () => finishDrag(false),
      onLostPointerCapture: () => finishDrag(false),
      onDoubleClick: () => commitWidth(CHAT_LIST_DEFAULT_WIDTH),
      onKeyDown,
    },
  };
}
