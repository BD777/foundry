import type { HTMLAttributes, LiHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { ButtonRow } from "./button-row";

/**
 * A person (or invite) in a list: identity, then badges, then actions. Give
 * `data-disabled` to dim the identity. Place it in a `DividedList`.
 */
export function MemberRow({
  className,
  ...props
}: LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={cn(
        "group grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 max-[640px]:grid-cols-[minmax(0,1fr)] [&>:first-child]:group-data-[disabled]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/** A member row's badges, or its actions: a wrapping line on the far side. */
export function MemberChips({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <ButtonRow
      align="end"
      className={cn("max-[640px]:justify-start", className)}
      gap="sm"
      {...props}
    />
  );
}
