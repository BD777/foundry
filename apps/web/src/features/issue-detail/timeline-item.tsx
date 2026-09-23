import { cva, type VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const timelineItemVariants = cva("fdy-timeline-item", {
  variants: {
    status: {
      active: "fdy-timeline-item-active",
      done: "fdy-timeline-item-done",
    },
    size: {
      md: "fdy-timeline-item-md",
      trace: "fdy-timeline-item-trace",
    },
  },
  defaultVariants: {
    size: "md",
    status: "done",
  },
});

export interface TimelineItemProps
  extends
    HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof timelineItemVariants> {
  label: ReactNode;
  meta?: ReactNode;
}

export function TimelineItem({
  className,
  label,
  meta,
  size,
  status,
  ...props
}: TimelineItemProps) {
  return (
    <div
      className={cn(timelineItemVariants({ size, status }), className)}
      {...props}
    >
      <span className="fdy-timeline-rail">
        <span className="fdy-timeline-node">
          {status === "active" ? null : (
            <Check size={size === "trace" ? 7 : 9} />
          )}
        </span>
        <span className="fdy-timeline-line" />
      </span>
      <span className="fdy-timeline-body">
        <strong>{label}</strong>
        {meta ? <p>{meta}</p> : null}
      </span>
    </div>
  );
}
