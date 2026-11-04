import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * After Beautiful UI's SegmentedControl (MIT, (c) 2026 Shane Levine): a pill
 * track and a raised pill for the selected segment, drawn from the Radix
 * toggle item's own `data-state`. The `fdy-segment*` classes are hooks only.
 */
export const segmentedControlVariants = cva(
  "fdy-segmented inline-flex w-max max-w-full select-none items-center gap-0.5 rounded-full bg-line/60 p-0.5",
  {
    variants: {
      size: {
        md: "fdy-segmented-md",
        sm: "fdy-segmented-sm",
      },
      tone: {
        neutral: "fdy-segmented-neutral",
        navigation:
          "fdy-segmented-navigation flex-wrap self-start justify-self-start",
      },
      /** Spread the segments over the full width, wrapping when they must. */
      fill: {
        true: "fdy-segmented-fill w-full flex-wrap [&>*]:min-w-0 [&>*]:flex-1",
        false: null,
      },
    },
    defaultVariants: {
      size: "md",
      tone: "neutral",
    },
  },
);

export const segmentItemVariants = cva(
  `fdy-segment inline-flex flex-none cursor-pointer items-center justify-center gap-1.5
   whitespace-nowrap rounded-full border-0 bg-transparent font-medium leading-none
   text-ink-2 transition-[background-color,color,box-shadow] duration-150
   hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1
   focus-visible:outline-(color:--fdy-accent) data-[state=on]:bg-surface
   data-[state=on]:text-ink data-[state=on]:shadow-hairline
   data-[disabled]:pointer-events-none data-[disabled]:opacity-50`,
  {
    variants: {
      size: {
        md: "fdy-segment-md h-7 px-3 text-sm",
        sm: "fdy-segment-sm h-6 px-2.5 text-xs",
      },
      tone: {
        neutral: "",
        navigation: "fdy-segment-navigation h-8 px-3.5 text-sm",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface SegmentOption<T extends string> {
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> extends VariantProps<
  typeof segmentedControlVariants
> {
  "aria-label": string;
  className?: string;
  /** Class of every segment, e.g. to adjust its padding. */
  itemClassName?: string;
  onValueChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  value: T;
}

export function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  className,
  fill,
  itemClassName,
  onValueChange,
  options,
  size,
  tone,
  value,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      aria-label={ariaLabel}
      className={cn(segmentedControlVariants({ fill, size, tone }), className)}
      onValueChange={(nextValue) => {
        if (nextValue) {
          onValueChange(nextValue as T);
        }
      }}
      type="single"
      value={value}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          className={cn(segmentItemVariants({ size, tone }), itemClassName)}
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
