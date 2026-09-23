import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const metaPillVariants = cva("fdy-meta-pill", {
  variants: {
    mono: {
      false: "",
      true: "fdy-meta-pill-mono",
    },
    size: {
      chip: "fdy-meta-pill-chip",
      xs: "fdy-meta-pill-xs",
      sm: "fdy-meta-pill-sm",
      md: "fdy-meta-pill-md",
    },
    intent: {
      none: "",
      update: "fdy-meta-pill-update",
    },
    tone: {
      neutral: "fdy-meta-pill-neutral",
      muted: "fdy-meta-pill-muted",
      brass: "fdy-meta-pill-brass",
    },
  },
  defaultVariants: {
    intent: "none",
    mono: false,
    size: "md",
    tone: "neutral",
  },
});

export interface MetaPillProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof metaPillVariants> {
  children: ReactNode;
}

export function MetaPill({
  children,
  className,
  intent,
  mono,
  size,
  tone,
  ...props
}: MetaPillProps) {
  return (
    <span
      className={cn(metaPillVariants({ intent, mono, size, tone }), className)}
      {...props}
    >
      {children}
    </span>
  );
}

export function MetaPillCaption({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("fdy-meta-pill-caption", className)} {...props} />;
}

export function MetaPillDot({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "blue" }) {
  return (
    <span
      className={cn(
        "fdy-meta-pill-dot",
        tone === "blue" ? "fdy-meta-pill-dot-blue" : null,
        className,
      )}
      {...props}
    />
  );
}

export function StatusDot({
  className,
  status,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { status: string }) {
  return (
    <span
      className={cn("fdy-status-dot", className)}
      data-status={status}
      {...props}
    />
  );
}
