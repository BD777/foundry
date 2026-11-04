import { cva, type VariantProps } from "class-variance-authority";
import {
  createContext,
  useContext,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";

/*
 * A value pill after Beautiful UI's ValuePill/Chip (MIT, (c) 2026 Shane
 * Levine): a hairline-edged capsule that holds a short value, optionally
 * monospaced, with a caption and a status dot. The `fdy-meta-pill*` classes
 * are hooks for tests and layout; they carry no style.
 */
export const metaPillVariants = cva(
  "fdy-meta-pill inline-flex flex-none items-center gap-2 whitespace-nowrap border border-line bg-panel text-xs leading-none font-bold text-ink",
  {
    variants: {
      mono: {
        false: "",
        true: "fdy-meta-pill-mono font-mono font-semibold",
      },
      size: {
        chip: "fdy-meta-pill-chip h-[26px] gap-[7px] rounded-md px-2.5 text-2xs leading-none",
        xs: "fdy-meta-pill-xs h-[22px] gap-1.5 rounded-full px-[9px] text-2xs leading-none font-semibold",
        sm: "fdy-meta-pill-sm h-6 gap-1.5 rounded-sm px-[9px] text-2xs leading-none",
        md: "fdy-meta-pill-md h-[33px] rounded-md px-3",
      },
      tone: {
        neutral: "fdy-meta-pill-neutral",
        muted: "fdy-meta-pill-muted border-line bg-panel-soft text-ink-muted",
        brass:
          "fdy-meta-pill-brass border-warning-border bg-warning-surface text-warning-text",
      },
      intent: {
        none: "",
        update:
          "fdy-meta-pill-update border-warning-border bg-warning-surface text-2xs leading-none text-warning-text",
      },
    },
    compoundVariants: [{ mono: true, size: "sm", className: "font-medium" }],
    defaultVariants: {
      intent: "none",
      mono: false,
      size: "md",
      tone: "neutral",
    },
  },
);

/** The pill's size, for the dot inside it. */
const MetaPillSize = createContext<"chip" | "xs" | "sm" | "md">("md");

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
    <MetaPillSize.Provider value={size ?? "md"}>
      <span
        className={cn(
          metaPillVariants({ intent, mono, size, tone }),
          className,
        )}
        {...props}
      >
        {children}
      </span>
    </MetaPillSize.Provider>
  );
}

export function MetaPillCaption({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "fdy-meta-pill-caption font-mono text-2xs font-medium text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

export function MetaPillDot({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "blue" }) {
  const small = useContext(MetaPillSize) === "chip";
  return (
    <span
      className={cn(
        "fdy-meta-pill-dot flex-none rounded-xs",
        small ? "size-1.5" : "size-[7px]",
        tone === "blue"
          ? "fdy-meta-pill-dot-blue bg-info-text"
          : "bg-warning-text",
        className,
      )}
      {...props}
    />
  );
}

const statusDotTone: Record<string, string> = {
  pending: "bg-success-text",
  accepted: "bg-success-text",
  in_progress: "animate-pulse-dot bg-warning-text",
  verifying: "bg-warning-text",
  blocked: "bg-info-text",
  abandoned: "bg-ink-muted",
};

export function StatusDot({
  className,
  status,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { status: string }) {
  return (
    <span
      className={cn(
        "fdy-status-dot size-2 flex-none rounded-full",
        statusDotTone[status] ?? "bg-ink-faint",
        className,
      )}
      data-status={status}
      {...props}
    />
  );
}
