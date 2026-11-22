import { Children, isValidElement, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A line of short facts ("Chat · name · kind · when") whose separators the
 * line draws itself. Each fact carries a leading dot of a fixed width; the row
 * is shifted left by that width and the line clips it, so the dot that starts
 * a row, the first one or one after a wrap, is never seen. A wrap therefore
 * never leaves a dot alone at a row's start or end. The dots are hidden from
 * screen readers. Empty children (null, false) take no place and no dot.
 */
export function MetaLine({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("min-w-0 overflow-hidden wrap-anywhere", className)}
      {...props}
    >
      <span className="-ms-[1.25em] flex min-w-0 flex-wrap items-center">
        {Children.toArray(children).map((child, index) => (
          <span
            className="inline-flex min-w-0 items-baseline"
            key={(isValidElement(child) && child.key) || index}
          >
            <span
              aria-hidden="true"
              className="inline-block w-[1.25em] flex-none text-center"
            >
              ·
            </span>
            {child}
          </span>
        ))}
      </span>
    </p>
  );
}
