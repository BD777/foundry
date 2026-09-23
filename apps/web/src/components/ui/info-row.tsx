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
  },
  defaultVariants: {
    density: "md",
    variant: "content",
  },
});

export interface InfoRowProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof infoRowVariants> {
  children?: ReactNode;
  endClassName?: string;
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
}

export function InfoRow({
  children,
  className,
  density,
  endClassName,
  icon,
  label,
  meta,
  variant,
  ...props
}: InfoRowProps) {
  return (
    <div
      className={cn(infoRowVariants({ density, variant }), className)}
      {...props}
    >
      {icon ? <span className="fdy-info-row-icon">{icon}</span> : null}
      <span className="fdy-info-row-body">
        <strong>{label}</strong>
        {meta ? <code>{meta}</code> : null}
      </span>
      {children ? (
        <span className={cn("fdy-info-row-end", endClassName)}>{children}</span>
      ) : null}
    </div>
  );
}
