import { Check } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button, type ButtonProps } from "../../components/ui/button";
import type { IssueStatus } from "@bd777/foundry-protocol";

export const issueCardVariants = cva(
  `relative block h-auto w-full max-w-full min-w-0 overflow-hidden whitespace-normal
   rounded-xl bg-panel bg-clip-padding px-3.5 py-3.25 text-left text-inherit shadow-card
   hover:shadow-raised focus-visible:shadow-panel-focus focus-visible:outline-0
   active:translate-y-px`,
  {
    variants: {
      selected: {
        false: "",
        true: "shadow-issue-selected hover:shadow-issue-selected",
      },
    },
    defaultVariants: {
      selected: false,
    },
  },
);

export interface IssueCardRootProps
  extends
    Omit<ButtonProps, "variant" | "size">,
    VariantProps<typeof issueCardVariants> {
  status?: IssueStatus;
}

/** One Issue on the board: the whole card opens it. */
export function IssueCardRoot({
  className,
  selected,
  status,
  ...props
}: IssueCardRootProps) {
  return (
    <Button
      className={cn(issueCardVariants({ selected }), className)}
      data-status={status}
      variant="bare"
      {...props}
    />
  );
}

export function IssueCardTopline({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "mb-[7px] flex min-w-0 items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardId({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "min-w-0 truncate font-mono text-2xs leading-tight font-semibold text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardSpark({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center justify-center text-warning-text",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <strong
      className={cn(
        "mb-[5px] block min-w-0 overflow-hidden text-md leading-[1.35] font-semibold text-ink wrap-anywhere text-pretty",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardCopy({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "mb-2.75 line-clamp-2 min-w-0 text-2xs leading-[1.45] font-normal text-ink-faint wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardStatusLine({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("mb-2.75 flex max-w-full min-w-0 items-center", className)}
      {...props}
    />
  );
}

export function IssueCardPill({
  children,
  className,
  dot = true,
  tone,
}: {
  children: ReactNode;
  className?: string;
  dot?: boolean;
  tone: NonNullable<BadgeProps["tone"]>;
}) {
  return (
    <Badge
      className={cn("min-w-[150px] justify-start", className)}
      dot={dot}
      tone={tone}
    >
      {children}
    </Badge>
  );
}

/** Work under way: an indeterminate bar, then what the Agent is doing. */
export function IssueCardProgress({ label }: { label: ReactNode }) {
  return (
    <span className="mb-2.75 block">
      <span className="relative mb-1.5 block h-[5px] overflow-hidden rounded-full bg-canvas">
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[42%] overflow-hidden bg-line-strong",
            "after:absolute after:inset-0 after:animate-sweep after:content-['']",
            "after:bg-[linear-gradient(90deg,transparent,var(--fdy-warning-text),transparent)]",
            "motion-reduce:after:animate-none",
          )}
        />
      </span>
      <span className="text-2xs leading-none font-medium text-warning-text">
        {label}
      </span>
    </span>
  );
}

export function IssueCardReviewLine({
  children,
  meta,
}: {
  children: ReactNode;
  meta: ReactNode;
}) {
  return (
    <span className="mb-2.75 flex min-w-0 items-center gap-1.75">
      {children}
      <span className="min-w-0 truncate text-2xs leading-tight font-medium text-ink-faint">
        {meta}
      </span>
    </span>
  );
}

export function IssueCardIntegratedLine({ children }: { children: ReactNode }) {
  return (
    <span className="mb-2.75 inline-flex max-w-full min-w-0 items-center gap-1.5 text-2xs leading-none font-semibold text-success-text wrap-anywhere">
      <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-success-surface text-success-text">
        <Check size={9} />
      </span>
      {children}
    </span>
  );
}

export function IssueCardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "flex max-w-full min-w-0 items-center gap-2 text-2xs leading-none font-medium text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

export function IssueCardFooterSpacer() {
  return <span className="flex-1" />;
}

const priorityVariants = cva(
  "inline-flex min-w-0 items-center gap-1 text-2xs leading-none font-semibold whitespace-nowrap",
  {
    variants: {
      priority: {
        high: "text-error-text",
        medium: "text-warning-text",
        low: "text-info-text",
      },
    },
  },
);

export function IssueCardPriority({
  children,
  icon,
  priority,
}: {
  children: ReactNode;
  icon?: ReactNode;
  priority: "high" | "low" | "medium";
}) {
  return (
    <span className={priorityVariants({ priority })} data-priority={priority}>
      {icon}
      {children}
    </span>
  );
}

export function IssuePriorityDashMark() {
  return <span className="h-0.5 w-2.75 rounded-full bg-current" />;
}

export function IssueCardUpdated({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("flex-none whitespace-nowrap", className)} {...props} />
  );
}
