import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * A row of a list or definition list after Beautiful UI's TextRow (MIT,
 * (c) 2026 Shane Levine): an optional icon, a label with a line of meta
 * beneath it, and an end slot. Rows are separated by a hairline.
 */
export const infoRowVariants = cva(
  "fdy-info-row flex min-w-0 items-center gap-3 border-t border-line-soft first:border-t-0",
  {
    variants: {
      density: {
        compact: "fdy-info-row-compact gap-3.5 py-[9px]",
        md: "fdy-info-row-md py-[13px]",
      },
      variant: {
        content: "fdy-info-row-content",
        keyValue: "fdy-info-row-key-value",
      },
      /** "warning" colors the label and meta, e.g. for the row that wins. */
      tone: {
        neutral: null,
        warning: "fdy-info-row-warning",
      },
    },
    defaultVariants: {
      density: "md",
      variant: "content",
    },
  },
);

export interface InfoRowProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof infoRowVariants> {
  bodyClassName?: string;
  children?: ReactNode;
  endClassName?: string;
  icon?: ReactNode;
  iconClassName?: string;
  label: ReactNode;
  meta?: ReactNode;
}

export function InfoRow({
  bodyClassName,
  children,
  className,
  density,
  endClassName,
  icon,
  iconClassName,
  label,
  meta,
  tone,
  variant,
  ...props
}: InfoRowProps) {
  const keyValue = variant === "keyValue";
  const labelTone = keyValue
    ? "text-xs leading-none text-ink-faint"
    : cn(
        "text-sm leading-[1.3]",
        tone === "warning" ? "text-warning-text" : "text-ink",
      );
  return (
    <div
      className={cn(infoRowVariants({ density, tone, variant }), className)}
      {...props}
    >
      {icon ? (
        <span
          className={cn(
            "fdy-info-row-icon inline-flex flex-none",
            iconClassName,
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className={cn("fdy-info-row-body min-w-0 flex-1", bodyClassName)}>
        <strong className={cn("font-semibold block truncate", labelTone)}>
          {label}
        </strong>
        {meta ? (
          <code
            className={cn(
              "font-mono block truncate text-2xs leading-[1.3] font-medium",
              tone === "warning" ? "text-warning-text" : "text-ink-faint",
            )}
          >
            {meta}
          </code>
        ) : null}
      </span>
      {children ? (
        <span
          className={cn(
            "fdy-info-row-end inline-flex max-w-[min(46%,220px)] min-w-0 flex-none items-center justify-end [&_code]:font-mono [&_code]:text-xs [&_code]:font-medium [&_code]:text-ink [&>*]:min-w-0",
            keyValue && "text-xs font-bold text-ink",
            endClassName,
          )}
        >
          {children}
        </span>
      ) : null}
    </div>
  );
}
