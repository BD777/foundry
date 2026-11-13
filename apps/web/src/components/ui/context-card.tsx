import { forwardRef, useId, type HTMLAttributes, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { IconBox, type IconBoxProps } from "./icon-box";
import { cn } from "../../lib/cn";

/*
 * A side panel's context card (the chat's, the assistant home's): one
 * floating card of sections of rows. Every row, icon, heading and status of
 * such a card is one of these, so a section reads as its neighbours do. The
 * `fdy-chat-context-*` classes are hooks for tests only.
 */

/** The card: one floating surface; neighbouring sections share one hairline. */
export function ContextCard({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <aside
      className={cn(
        "relative overflow-hidden rounded-xl bg-panel shadow-floating [&>section+section]:border-t [&>section+section]:border-line",
        className,
      )}
      {...props}
    />
  );
}

/** One titled block of the card; neighbouring blocks share one hairline. */
export function ContextSection({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("fdy-chat-context-section px-5 pt-5 pb-4.5", className)}
      {...props}
    />
  );
}

/**
 * Sections of one kind under a small label, as the sidebar groups its
 * pages: what is running apart from what the chat produced. The label is a
 * soft band across the card, so a group's edge reads apart from the hairline
 * between two of its sections.
 */
export function ContextGroup({
  children,
  kind,
  label,
}: {
  children: ReactNode;
  kind: string;
  label: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="fdy-chat-context-group [&>h2+section]:pt-4 [&>section+section]:border-t [&>section+section]:border-line"
      data-group={kind}
    >
      <h2
        className="bg-panel-soft px-5 py-1.5 text-xs leading-[1.4] font-semibold text-ink-muted"
        id={id}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

/**
 * A section's title, with the count of what it holds; `action` sits at the
 * title's end (a link to the whole list, or an empty section's quiet word).
 */
export function ContextHeading({
  action,
  children,
  className,
  count,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  count?: number;
}) {
  const heading = (
    <h3
      className={cn(
        "text-sm leading-[1.2] font-bold text-ink-faint",
        action ? "min-w-0" : "mb-3.25",
        action ? undefined : className,
      )}
    >
      {children}
      {count ? (
        <span className="ml-1.5 font-medium text-ink-faint">{count}</span>
      ) : null}
    </h3>
  );
  if (!action) return heading;
  return (
    <div
      className={cn(
        "mb-3.25 flex min-h-6 min-w-0 items-center justify-between gap-2",
        className,
      )}
    >
      {heading}
      {action}
    </div>
  );
}

export function ContextList({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-2.5", className)} {...props} />;
}

/** A section's quiet line: what is not there yet. */
export function ContextEmpty({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-xs leading-[1.45] text-ink-faint", className)}
      {...props}
    />
  );
}

const rowLayout =
  "fdy-chat-context-row flex min-h-[30px] w-full min-w-0 items-center justify-start gap-2.5 rounded-lg px-1.5 py-1 text-left active:scale-100";

/** A row that opens its item; `selected` marks the item the panel shows. */
export const ContextRow = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "variant" | "size"> & { selected?: boolean }
>(function ContextRow({ className, selected, ...props }, ref) {
  return (
    <Button
      className={cn(
        rowLayout,
        "hover:bg-control-ghost-hover focus-visible:outline-accent-line focus-visible:outline-offset-1 data-[selected=true]:bg-control-ghost-hover",
        className,
      )}
      data-selected={selected === undefined ? undefined : String(selected)}
      ref={ref}
      variant="ghost"
      {...props}
    />
  );
});

/** A row that shows an item without opening it. */
export function ContextStaticRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn(rowLayout, className)} data-static="true" {...props} />
  );
}

const iconTone = {
  muted: "",
  preview: "",
  timer: "bg-panel-soft text-info-text",
  background: "bg-panel-soft text-ink-muted",
} as const;

/**
 * The 28px mark that starts a row; `tone` gives it the meaning of what the
 * row holds (a question, a failure), beside its shape.
 */
export function ContextRowIcon({
  children,
  kind = "muted",
  tone,
}: {
  children: ReactNode;
  kind?: keyof typeof iconTone;
  tone?: IconBoxProps["tone"];
}) {
  return (
    <IconBox
      className={cn("size-7 rounded-md", tone ? undefined : iconTone[kind])}
      size="row"
      tone={tone ?? (kind === "preview" ? "brass" : "muted")}
    >
      {children}
    </IconBox>
  );
}

const avatarTone = {
  1: "bg-brand",
  2: "bg-success-text",
  3: "bg-info-text",
} as const;

/** A subagent's round mark; its colour follows its place in the list. */
export function ContextAvatar({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 1 | 2 | 3;
}) {
  return (
    <IconBox
      className={cn(
        "size-7 rounded-full text-on-brand [&_svg]:stroke-[1.9]",
        avatarTone[tone],
      )}
      size="row"
      tone="muted"
    >
      {children}
    </IconBox>
  );
}

/** A row's title with a quieter line under it. */
export function ContextRowCopy({
  detail,
  title,
}: {
  detail?: ReactNode;
  title: ReactNode;
}) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <strong className="truncate text-sm leading-[1.3] font-semibold text-ink">
        {title}
      </strong>
      {detail ? (
        <em className="truncate text-2xs leading-tight font-medium text-ink-faint not-italic">
          {detail}
        </em>
      ) : null}
    </span>
  );
}

const statusTone = {
  default: "text-ink-faint",
  running:
    "text-ink-muted [&_svg]:animate-spin-slow motion-reduce:[&_svg]:animate-none",
  failed: "text-error-text",
} as const;

/** A row's status: icon and word, never colour alone. */
export function ContextStatus({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: keyof typeof statusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1 text-2xs leading-none font-semibold whitespace-nowrap",
        statusTone[tone],
      )}
    >
      {children}
    </span>
  );
}

/** The status tone of a work item that is running, failed or neither. */
export function statusToneOf(status: string): keyof typeof statusTone {
  return status === "running" || status === "failed" ? status : "default";
}
