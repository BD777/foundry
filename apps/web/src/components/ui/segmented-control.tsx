import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const segmentedControlVariants = cva("fdy-segmented", {
  variants: {
    size: {
      md: "fdy-segmented-md",
      sm: "fdy-segmented-sm",
    },
    tone: {
      neutral: "fdy-segmented-neutral",
      navigation: "fdy-segmented-navigation",
    },
    /** Spread the segments over the full width, wrapping when they must. */
    fill: {
      true: "fdy-segmented-fill",
      false: null,
    },
  },
  defaultVariants: {
    size: "md",
    tone: "neutral",
  },
});

export const segmentItemVariants = cva("fdy-segment", {
  variants: {
    size: {
      md: "fdy-segment-md",
      sm: "fdy-segment-sm",
    },
    tone: {
      neutral: "",
      navigation: "fdy-segment-navigation",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

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
