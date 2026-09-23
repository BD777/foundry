import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

interface ChatDetailSplitPaneProps {
  children: ReactNode;
  detail?: ReactNode;
  detailLabel: string;
}

export function ChatDetailSplitPane({
  children,
  detail,
  detailLabel,
}: ChatDetailSplitPaneProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const detailOpen = detail !== undefined && detail !== null;

  const setDetailWidth = useCallback((width: number) => {
    rootRef.current?.style.setProperty(
      "--fdy-chat-detail-width",
      `${Math.round(width)}px`,
    );
  }, []);

  const resizeFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root || !event.currentTarget.hasPointerCapture(event.pointerId)) {
        return;
      }
      setDetailWidth(root.getBoundingClientRect().right - event.clientX);
    },
    [setDetailWidth],
  );

  const stopResizing = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    delete event.currentTarget.dataset.active;
    if (root) {
      delete root.dataset.resizing;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const detailElement = detailRef.current;
    const resizer = resizerRef.current;
    if (
      !detailOpen ||
      !root ||
      !detailElement ||
      !resizer ||
      typeof ResizeObserver === "undefined"
    ) {
      return undefined;
    }
    const syncAccessibleValue = (): void => {
      const width = Math.round(detailElement.getBoundingClientRect().width);
      resizer.setAttribute("aria-valuemax", `${Math.round(root.clientWidth)}`);
      resizer.setAttribute("aria-valuenow", `${width}`);
      resizer.setAttribute("aria-valuetext", `${width} pixels`);
    };
    const observer = new ResizeObserver(syncAccessibleValue);
    observer.observe(root);
    observer.observe(detailElement);
    syncAccessibleValue();
    return () => observer.disconnect();
  }, [detailOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const detailElement = detailRef.current;
      if (!root || !detailElement) {
        return;
      }
      let nextWidth: number | undefined;
      if (event.key === "ArrowLeft") {
        nextWidth = detailElement.getBoundingClientRect().width + 32;
      } else if (event.key === "ArrowRight") {
        nextWidth = detailElement.getBoundingClientRect().width - 32;
      } else if (event.key === "Home") {
        nextWidth = 0;
      } else if (event.key === "End") {
        nextWidth = root.clientWidth;
      }
      if (nextWidth === undefined) {
        return;
      }
      event.preventDefault();
      setDetailWidth(nextWidth);
    },
    [setDetailWidth],
  );

  return (
    <div
      className="fdy-chat-thread-layout"
      data-detail-open={detailOpen ? "true" : "false"}
      ref={rootRef}
    >
      {children}
      {detailOpen ? (
        <>
          <div
            aria-label={`Resize ${detailLabel}`}
            aria-orientation="vertical"
            aria-valuemin={0}
            className="fdy-chat-detail-resizer"
            onDoubleClick={() =>
              rootRef.current?.style.removeProperty("--fdy-chat-detail-width")
            }
            onKeyDown={handleKeyDown}
            onLostPointerCapture={stopResizing}
            onPointerCancel={stopResizing}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse" && event.button !== 0) {
                return;
              }
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.dataset.active = "true";
              if (rootRef.current) {
                rootRef.current.dataset.resizing = "true";
              }
            }}
            onPointerMove={resizeFromPointer}
            onPointerUp={stopResizing}
            ref={resizerRef}
            role="separator"
            tabIndex={0}
          />
          <aside
            aria-label={detailLabel}
            className="fdy-chat-detail-rail"
            ref={detailRef}
          >
            {detail}
          </aside>
        </>
      ) : null}
    </div>
  );
}
