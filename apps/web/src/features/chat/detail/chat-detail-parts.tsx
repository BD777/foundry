import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../../lib/cn";

/*
 * The parts the chat detail panel's views share. The panel is a container
 * (`fdy-chat-detail`): at 460px and below its content takes a 16px inset
 * instead of 32px, whatever the viewport.
 */

/** An icon button in the panel's title bar. */
export const detailAction = "size-[30px] flex-none rounded-md text-ink-muted";

/** The horizontal inset of a document, a download status or a feedback. */
export const detailInset = "px-8 @max-[460px]/fdy-chat-detail:px-4";

/** A document: a file, a conversation, a diff. */
export const detailDocument = cn(
  "pt-7 pb-15 text-md leading-[1.65] text-ink",
  detailInset,
  "max-[860px]:px-5",
);

/** What stands in for a body that has nothing to show, or failed. */
export function DetailMessage({
  className,
  tone = "empty",
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: "empty" | "error" }) {
  return (
    <div
      className={cn(
        "flex min-h-[180px] items-center justify-center gap-2 p-7 text-center text-sm leading-normal",
        tone === "error" ? "text-error-text" : "text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

/** A failed read stands in for the file, in line with its content. */
export function DetailFeedback({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("py-4", detailInset, className)} {...props} />;
}

/** A timer or background task's detail: label and value rows, then text. */
export function MetaDetail({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <article
      className={cn(
        "grid gap-3 px-7 pt-6 pb-12 @max-[460px]/fdy-chat-detail:px-4",
        className,
      )}
      {...props}
    />
  );
}

export function MetaList(props: HTMLAttributes<HTMLDListElement>) {
  return <dl className="grid gap-2" {...props} />;
}

export function MetaRow({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-baseline gap-2.5">
      <dt className="text-2xs text-ink-faint">{label}</dt>
      <dd className="text-xs text-ink [&_code]:rounded-xs [&_code]:bg-control-ghost-hover [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-2xs">
        {children}
      </dd>
    </div>
  );
}

export function MetaHeading({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h4
      className={cn(
        "mt-1 text-2xs font-semibold text-ink-muted [&_small]:ml-1.5 [&_small]:text-2xs [&_small]:font-medium [&_small]:text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

export function MetaNote({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-xs leading-normal text-ink-muted", className)}
      {...props}
    />
  );
}

export function MetaPre({
  className,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  return (
    <pre
      className={cn(
        "max-h-[180px] overflow-auto rounded-lg bg-control-ghost-hover px-3 py-2.5 font-mono text-2xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink",
        className,
      )}
      {...props}
    />
  );
}
