import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Panel, type PanelProps } from "./panel";
import { MutedText } from "./text";

export const sectionPanelVariants = cva("grid min-w-0", {
  variants: {
    spacing: {
      cozy: "gap-3 p-4.5",
      roomy: "gap-3.5 p-4.5",
      wide: "gap-4 p-5.5",
    },
  },
  defaultVariants: { spacing: "cozy" },
});

export interface SectionPanelProps
  extends PanelProps, VariantProps<typeof sectionPanelVariants> {}

/** A page section on a panel: its parts stacked with a steady gap. */
export function SectionPanel({
  className,
  spacing,
  ...props
}: SectionPanelProps) {
  return (
    <Panel
      className={cn(sectionPanelVariants({ spacing }), className)}
      {...props}
    />
  );
}

/** The heading of a section panel: a bold title and a line of what it is for. */
export function SectionHead({
  className,
  description,
  title,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className={cn("grid gap-1", className)} {...props}>
      <strong className="text-md font-bold text-ink">{title}</strong>
      {description ? (
        <MutedText className="leading-[1.55]">{description}</MutedText>
      ) : null}
    </div>
  );
}
