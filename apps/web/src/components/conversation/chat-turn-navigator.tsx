import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "../ui/button";
import {
  sampleChatTurnIndexes,
  type ChatTurnAnchor,
} from "./chat-turn-navigation";

const MAX_RENDERED_TURN_MARKERS = 80;

export const ChatTurnNavigator = memo(function ChatTurnNavigator({
  activeIndex,
  anchors,
  onNavigate,
}: {
  activeIndex: number;
  anchors: readonly ChatTurnAnchor[];
  onNavigate: (anchor: ChatTurnAnchor) => void;
}) {
  const markerRefs = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocusRef = useRef<number | undefined>(undefined);
  const [keyboardIndex, setKeyboardIndex] = useState<number>();
  const [previewIndex, setPreviewIndex] = useState<number>();
  const markerIndexes = useMemo(
    () =>
      sampleChatTurnIndexes(anchors.length, MAX_RENDERED_TURN_MARKERS, [
        activeIndex,
        keyboardIndex ?? -1,
        previewIndex ?? -1,
      ]),
    [activeIndex, anchors.length, keyboardIndex, previewIndex],
  );
  const previewMarkerPosition =
    previewIndex === undefined ? -1 : markerIndexes.indexOf(previewIndex);
  const density =
    markerIndexes.length <= 16
      ? "relaxed"
      : markerIndexes.length <= 40
        ? "compact"
        : "dense";

  useLayoutEffect(() => {
    const pendingIndex = pendingFocusRef.current;
    if (pendingIndex === undefined) {
      return;
    }
    pendingFocusRef.current = undefined;
    markerRefs.current.get(pendingIndex)?.focus();
  }, [markerIndexes]);

  const focusTurn = useCallback(
    (index: number): void => {
      const nextIndex = Math.max(0, Math.min(anchors.length - 1, index));
      pendingFocusRef.current = nextIndex;
      setKeyboardIndex(nextIndex);
      setPreviewIndex(nextIndex);
    },
    [anchors.length],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
      if (event.key === "Enter" || event.key === " ") {
        const anchor = anchors[index];
        if (anchor) {
          event.preventDefault();
          onNavigate(anchor);
        }
        return;
      }
      let nextIndex: number | undefined;
      if (event.key === "ArrowUp") {
        nextIndex = index - 1;
      } else if (event.key === "ArrowDown") {
        nextIndex = index + 1;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = anchors.length - 1;
      }
      if (nextIndex === undefined) {
        return;
      }
      event.preventDefault();
      focusTurn(nextIndex);
    },
    [anchors, focusTurn, onNavigate],
  );

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLElement>): void => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }
      setKeyboardIndex(undefined);
      setPreviewIndex(undefined);
    },
    [],
  );

  return (
    <TooltipPrimitive.Provider delayDuration={140} skipDelayDuration={180}>
      <nav
        aria-label="Conversation turns"
        className="fdy-chat-turn-nav"
        data-expanded={previewIndex !== undefined ? "true" : "false"}
        onBlurCapture={handleBlurCapture}
        onPointerLeave={() => setPreviewIndex(undefined)}
        onPointerCancel={() => setPreviewIndex(undefined)}
      >
        <div className="fdy-chat-turn-list" data-density={density}>
          {markerIndexes.map((index, markerPosition) => {
            const anchor = anchors[index];
            if (!anchor) {
              return null;
            }
            const current = index === activeIndex;
            const previewDistance =
              previewMarkerPosition < 0
                ? 3
                : Math.min(3, Math.abs(markerPosition - previewMarkerPosition));
            const tabIndex = index === (keyboardIndex ?? activeIndex) ? 0 : -1;
            return (
              <TooltipPrimitive.Root key={anchor.id}>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    aria-current={current ? "step" : undefined}
                    aria-label={`${
                      current ? "Current" : "Go to"
                    } turn ${index + 1} of ${anchors.length}: ${
                      anchor.accessibleLabel
                    }`}
                    className="fdy-chat-turn-marker"
                    data-current={current ? "true" : "false"}
                    data-distance={previewDistance}
                    onClick={() => onNavigate(anchor)}
                    onFocus={() => {
                      setKeyboardIndex(index);
                      setPreviewIndex(index);
                    }}
                    onKeyDown={(event) => handleKeyDown(event, index)}
                    onPointerEnter={() => setPreviewIndex(index)}
                    ref={(node) => {
                      if (node) {
                        markerRefs.current.set(index, node);
                      } else {
                        markerRefs.current.delete(index);
                      }
                    }}
                    size="icon"
                    tabIndex={tabIndex}
                    variant="ghost"
                  >
                    <span className="fdy-chat-turn-line" aria-hidden="true" />
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    align="center"
                    className="fdy-chat-turn-preview"
                    collisionPadding={14}
                    side="right"
                    sideOffset={12}
                  >
                    {anchor.query}
                    <TooltipPrimitive.Arrow className="fdy-chat-turn-preview-arrow" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>
            );
          })}
        </div>
      </nav>
    </TooltipPrimitive.Provider>
  );
});
