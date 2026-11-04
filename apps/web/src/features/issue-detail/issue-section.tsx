import { Slot } from "@radix-ui/react-slot";
import type { ComponentPropsWithoutRef, HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Panel, type PanelProps } from "../../components/ui/panel";

export interface IssueSectionProps extends ComponentPropsWithoutRef<"section"> {
  /** Render the child element (an `article`, a `details`) as the section. */
  asChild?: boolean;
}

/**
 * One block of the Issue details: a raised card whose headings, paragraphs and
 * preformatted text are laid out by it (the markup inside is plain).
 */
export function IssueSection({
  asChild = false,
  className,
  ...props
}: IssueSectionProps) {
  const Component = asChild ? Slot : "section";
  return (
    <Component
      className={cn(
        "grid min-w-0 gap-2.5 rounded-xl bg-panel p-4.5 shadow-card wrap-anywhere",
        "[&_h3]:text-md [&_h4]:text-sm",
        "[&_pre]:max-h-[360px] [&_pre]:overflow-y-auto [&_pre]:break-words [&_pre]:whitespace-pre-wrap",
        className,
      )}
      {...props}
    />
  );
}

/** A criterion, a finding: a block inside a section, divided from the one before. */
export function IssueSubsection({
  asChild = false,
  className,
  divided = false,
  ...props
}: ComponentPropsWithoutRef<"article"> & {
  asChild?: boolean;
  divided?: boolean;
}) {
  const Component = asChild ? Slot : "article";
  return (
    <Component
      className={cn(
        "grid gap-2 py-3 [&_ul]:m-0 [&_ul]:pl-5",
        divided && "border-t border-line",
        className,
      )}
      {...props}
    />
  );
}

/** The meta line of a block: the path or version it refers to. */
export function IssueMetaLine({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "mb-5 max-w-[620px] text-2xs leading-normal text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

/** A panel of the environment and review blocks. */
export function ExecutionPanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      className={cn(
        "mt-3 grid min-w-0 gap-3 p-4 text-sm leading-[1.6]",
        className,
      )}
      {...props}
    />
  );
}
