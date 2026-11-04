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
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import {
  sampleChatTurnIndexes,
  type ChatTurnAnchor,
} from "./chat-turn-navigation";

const MAX_RENDERED_TURN_MARKERS = 80;

/** A marker's height by how many turns the rail shows. */
const markerHeights = {
  relaxed: "h-[18px] flex-[0_1_18px]",
  compact: "h-[9px] flex-[0_1_9px]",
  dense: "h-1 flex-[0_1_4px]",
} as const;

const listGaps = { relaxed: "gap-0.5", compact: "gap-px", dense: "gap-0" };

/** How far a marker's line stretches with the pointer's distance from it. */
const lineScales = [
  "[transform:scaleX(1)]",
  "[transform:scaleX(0.76)]",
  "[transform:scaleX(0.54)]",
];

export const ChatTurnNavigator = memo(function ChatTurnNavigator({
  activeIndex,
  anchors,
  onNavigate,
}: {
  activeIndex: number;
  anchors: readonly ChatTurnAnchor[];
  onNavigate: (anchor: ChatTurnAnchor) => void;
}) {
  const { t } = useTranslation("conversation");
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
        aria-label={t("turns.navigator")}
        className="fdy-chat-turn-nav pointer-events-none absolute top-6 bottom-6 left-[max(8px,calc((100%_-_var(--fdy-chat-turn-gutter)_-_var(--fdy-chat-content-max))/2_+_var(--fdy-chat-turn-gutter)_-_var(--fdy-chat-turn-marker-width)_-_12px))] z-5 hidden w-(--fdy-chat-turn-marker-width) items-center fine-pointer:@min-[560px]/chat-conversation:flex"
        data-expanded={previewIndex !== undefined ? "true" : "false"}
        onBlurCapture={handleBlurCapture}
        onPointerLeave={() => setPreviewIndex(undefined)}
        onPointerCancel={() => setPreviewIndex(undefined)}
      >
        <div
          className={cn(
            "pointer-events-auto flex max-h-full w-(--fdy-chat-turn-marker-width) flex-col",
            listGaps[density],
          )}
          data-density={density}
        >
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
                    aria-label={t(current ? "turns.current" : "turns.goTo", {
                      index: index + 1,
                      total: anchors.length,
                      label: anchor.accessibleLabel,
                    })}
                    className={cn(
                      "min-h-[3px] w-(--fdy-chat-turn-marker-width) min-w-(--fdy-chat-turn-marker-width) justify-start rounded-xs bg-transparent p-0 text-ink-faint hover:bg-transparent active:scale-100 data-[current=true]:text-ink",
                      markerHeights[density],
                    )}
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
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block h-0.5 w-[calc(var(--fdy-chat-turn-marker-width)_-_6px)] flex-none origin-left rounded-xs bg-current [transform:scaleX(var(--fdy-chat-turn-rest-scale))] transition-[color,transform] [transition-duration:0.14s,0.2s] [transition-timing-function:ease,cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                        previewIndex !== undefined &&
                          lineScales[previewDistance],
                      )}
                    />
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    align="center"
                    className="pointer-events-none z-50 line-clamp-6 max-h-[9em] max-w-[min(380px,calc(100vw-96px))] origin-(--radix-tooltip-content-transform-origin) animate-turn-preview-in rounded-xl bg-panel px-[17px] py-[15px] text-md leading-normal font-semibold wrap-anywhere text-ink shadow-raised motion-reduce:animate-none"
                    collisionPadding={14}
                    side="right"
                    sideOffset={12}
                  >
                    {anchor.query}
                    <TooltipPrimitive.Arrow className="fill-panel" />
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
