import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const infoRowVariants = cva("fdy-info-row", {
  variants: {
    density: {
      compact: "fdy-info-row-compact",
      md: "fdy-info-row-md",
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
});

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
  return (
    <div
      className={cn(infoRowVariants({ density, tone, variant }), className)}
      {...props}
    >
      {icon ? (
        <span className={cn("fdy-info-row-icon", iconClassName)}>{icon}</span>
      ) : null}
      <span className={cn("fdy-info-row-body", bodyClassName)}>
        <strong>{label}</strong>
        {meta ? <code>{meta}</code> : null}
      </span>
      {children ? (
        <span className={cn("fdy-info-row-end", endClassName)}>{children}</span>
      ) : null}
    </div>
  );
}
