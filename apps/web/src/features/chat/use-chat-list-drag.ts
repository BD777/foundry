import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ChatDropTarget } from "./chat-layout";

const dragType = "application/x-foundry-chat";

export function useChatListDrag(
  enabled: boolean,
  onMove: (chatId: string, target: ChatDropTarget) => void,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<string | undefined>(undefined);
  const targetRef = useRef<ChatDropTarget | undefined>(undefined);
  const speedRef = useRef(0);
  const [draggingId, setDraggingId] = useState<string>();
  const [target, setTarget] = useState<ChatDropTarget>();
  const end = () => {
    sourceRef.current = undefined;
    targetRef.current = undefined;
    speedRef.current = 0;
    setDraggingId(undefined);
    setTarget(undefined);
  };
  useEffect(() => {
    if (!draggingId) return;
    let frame: number;
    const scroll = () => {
      viewportRef.current?.scrollBy(0, speedRef.current);
      frame = window.requestAnimationFrame(scroll);
    };
    frame = window.requestAnimationFrame(scroll);
    return () => window.cancelAnimationFrame(frame);
  }, [draggingId]);
  useEffect(() => {
    if (!enabled) end();
  }, [enabled]);

  return {
    viewportRef,
    draggingId,
    indicator: (groupId: string, chatId?: string) =>
      target && target.groupId === groupId && target.chatId === chatId
        ? target.edge
        : undefined,
    start: (event: DragEvent, chatId: string) => {
      if (!enabled) {
        event.preventDefault();
        return;
      }
      sourceRef.current = chatId;
      setDraggingId(chatId);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(dragType, chatId);
    },
    end,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (
          !enabled ||
          !sourceRef.current ||
          !event.dataTransfer.types.includes(dragType)
        )
          return;
        const element = (event.target as Element).closest<HTMLElement>(
          "[data-chat-drop]",
        );
        if (!element || !event.currentTarget.contains(element)) {
          targetRef.current = undefined;
          setTarget(undefined);
          speedRef.current = 0;
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = element.getBoundingClientRect();
        const chatId = element.dataset.chatId;
        const next: ChatDropTarget = {
          groupId: element.dataset.groupId ?? "",
          chatId,
          edge:
            chatId && event.clientY > rect.top + rect.height / 2
              ? "after"
              : "before",
        };
        targetRef.current = next;
        setTarget((current) =>
          current?.chatId === next.chatId &&
          current?.groupId === next.groupId &&
          current?.edge === next.edge
            ? current
            : next,
        );
        const viewport = viewportRef.current?.getBoundingClientRect();
        speedRef.current = !viewport
          ? 0
          : event.clientY < viewport.top + 40
            ? -10
            : event.clientY > viewport.bottom - 40
              ? 10
              : 0;
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        targetRef.current = undefined;
        setTarget(undefined);
        speedRef.current = 0;
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const id = sourceRef.current;
        const destination = targetRef.current;
        if (
          !enabled ||
          !id ||
          !destination ||
          event.dataTransfer.getData(dragType) !== id
        ) {
          end();
          return;
        }
        event.preventDefault();
        onMove(id, destination);
        end();
      },
    },
  };
}
