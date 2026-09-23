import { Check } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button, type ButtonProps } from "../../components/ui/button";
import { MetaPill, MetaPillDot } from "../../components/ui/meta-pill";

type IssueCardPillTone =
  "brass" | "error" | "neutral" | "online" | "slate" | "warn";

export const issueCardVariants = cva("fdy-issue-card", {
  variants: {
    selected: {
      false: "",
      true: "fdy-issue-card-selected",
    },
    status: {
      blocked: "fdy-issue-card-blocked",
      pending: "fdy-issue-card-ready",
      accepted: "fdy-issue-card-integrated",
      in_progress: "fdy-issue-card-producing",
      verifying: "fdy-issue-card-review",
      abandoned: "fdy-issue-card-blocked",
    },
  },
  defaultVariants: {
    selected: false,
  },
});

export interface IssueCardRootProps
  extends ButtonProps, VariantProps<typeof issueCardVariants> {}

export function IssueCardRoot({
  className,
  selected,
  status,
  ...props
}: IssueCardRootProps) {
  return (
    <Button
      className={cn(issueCardVariants({ selected, status }), className)}
      data-status={status}
      variant="ghost"
      {...props}
    />
  );
}

export function IssueCardTopline({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("fdy-issue-card-topline", className)} {...props} />
  );
}

export function IssueCardId({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fdy-issue-card-id", className)} {...props} />;
}

export function IssueCardSpark({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fdy-issue-card-spark", className)} {...props} />;
}

export function IssueCardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <strong className={cn("fdy-issue-card-title", className)} {...props} />
  );
}

export function IssueCardCopy({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fdy-issue-card-copy", className)} {...props} />;
}

export function IssueCardStatusLine({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("fdy-issue-card-status-line", className)} {...props} />
  );
}

export function IssueCardPill({
  children,
  dot = true,
  tone,
}: {
  children: ReactNode;
  dot?: boolean;
  tone: IssueCardPillTone;
}) {
  return (
    <MetaPill className="fdy-issue-card-pill" data-tone={tone} size="xs">
      {dot ? <MetaPillDot /> : null}
      {children}
    </MetaPill>
  );
}

export function IssueCardProgress({ label }: { label: ReactNode }) {
  return (
    <span className="fdy-issue-progress">
      <span className="fdy-issue-progress-track">
        <span />
      </span>
      <span>{label}</span>
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
    <span className="fdy-issue-review-line">
      {children}
      <span>{meta}</span>
    </span>
  );
}

export function IssueCardIntegratedLine({ children }: { children: ReactNode }) {
  return (
    <span className="fdy-issue-integrated-line">
      <span className="fdy-issue-integrated-mark">
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
  return <span className={cn("fdy-issue-card-footer", className)} {...props} />;
}

export function IssueCardFooterSpacer() {
  return <span className="fdy-issue-card-footer-spacer" />;
}

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
    <span className="fdy-issue-card-priority" data-priority={priority}>
      {icon}
      {children}
    </span>
  );
}

export function IssuePriorityDashMark() {
  return <span className="fdy-priority-mark-dash" />;
}

export function IssueCardUpdated({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("fdy-issue-card-updated", className)} {...props} />
  );
}
