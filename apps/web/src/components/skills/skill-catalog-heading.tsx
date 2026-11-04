import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The heading of a skills section: title and a line of what it holds on the
 * left, its actions on the right (wrapping beneath when narrow). The
 * `fdy-skill-catalog-heading` class is a hook for tests and carries no style.
 */
export function SkillCatalogHeading({
  actions,
  className,
  description,
  title,
  titleId,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  actions?: ReactNode;
  description?: ReactNode;
  title?: ReactNode;
  /** Id of the title, for the section's `aria-labelledby`. */
  titleId?: string;
}) {
  return (
    <header
      className={cn(
        "fdy-skill-catalog-heading flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-[1_1_320px]">
        {title ? (
          <h2 className="mb-1 text-md font-[650] text-ink" id={titleId}>
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="mb-3 text-xs leading-normal text-ink-faint">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
