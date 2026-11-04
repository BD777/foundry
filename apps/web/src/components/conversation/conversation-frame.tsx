import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * The frame a conversation sits in, shared by Chat and an Issue: the screen,
 * the thread (a size container named `fdy-chat-thread`, which the detail pane
 * queries) and the thread's header. Hosts add their own layout through
 * `className`.
 */

export function ChatScreen({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "fdy-chat-screen flex h-full animate-chat-screen-in flex-col data-[list-resizing=true]:cursor-col-resize data-[list-resizing=true]:select-none max-[860px]:min-h-0",
        className,
      )}
      {...props}
    />
  );
}

export function ChatThread({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fdy-chat-thread @container/chat-thread flex min-h-0 min-w-0 flex-1 flex-col",
        className,
      )}
      {...props}
    />
  );
}

export function ConversationHeader({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn(
        "fdy-chat-thread-header flex flex-none items-center gap-2.5 border-b border-line px-[22px] py-[13px] max-[860px]:px-[18px]",
        className,
      )}
      {...props}
    />
  );
}

/** The thread's title, with an optional small caption under it. */
export function ChatThreadTitle({
  caption,
  title,
}: {
  caption?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="fdy-chat-thread-title min-w-0 flex-1">
      <strong className="block truncate text-md leading-[1.3] font-semibold text-ink max-[860px]:leading-tight">
        {title}
      </strong>
      {caption ? (
        <span className="mt-[3px] block truncate text-2xs leading-tight font-bold text-ink-faint uppercase">
          {caption}
        </span>
      ) : null}
    </div>
  );
}
