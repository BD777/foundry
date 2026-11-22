import { Children, isValidElement, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A line of short facts ("Chat · name · kind · when") whose separators the
 * line draws itself. Each fact carries a leading dot of a fixed width; the row
 * is shifted left by that width and the line clips its left edge, so the dot
 * that starts a row, the first one or one after a wrap, is never seen. A wrap
 * therefore never leaves a dot alone at a row's start or end. Only the left
 * edge clips, 4px out, so a focus outline (2px, 2px off) of a control in the
 * line stays whole; the hidden dot sits at least half its 1.25em box away.
 * The dots are hidden from screen readers. Empty children (null, false) take
 * no place and no dot.
 *
 * `as` picks the element: a `span` where a block may not go (a label, a
 * `small`), still laid out as a block. `separatorClassName` styles the dots
 * apart from the facts (a fainter color, a normal weight in a bold label).
 */
export function MetaLine({
  as: Component = "p",
  children,
  className,
  separatorClassName,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "p" | "span" | "div";
  separatorClassName?: string;
}) {
  return (
    <Component
      className={cn(
        "block min-w-0 [clip-path:inset(-100vmax_-100vmax_-100vmax_-4px)] wrap-anywhere",
        className,
      )}
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
              className={cn(
                "inline-block w-[1.25em] flex-none text-center",
                separatorClassName,
              )}
            >
              ·
            </span>
            {child}
          </span>
        ))}
      </span>
    </Component>
  );
}
