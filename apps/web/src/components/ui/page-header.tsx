import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface PageHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the heading's far side; they wrap beneath it when narrow. */
  actions?: ReactNode;
}

/** The one heading of a page: title, a line of what it is for, its actions. */
export function PageHeader({
  actions,
  className,
  description,
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header className={cn("fdy-page-header", className)} {...props}>
      <div className="fdy-page-header-copy">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? (
        <div className="fdy-page-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}

export interface SectionHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Id of the title, for the section's `aria-labelledby`. */
  titleId?: string;
}

/** The heading of a section inside a page: same shape, one level down. */
export function SectionHeader({
  actions,
  className,
  description,
  title,
  titleId,
  ...props
}: SectionHeaderProps) {
  return (
    <header className={cn("fdy-section-header", className)} {...props}>
      <div className="fdy-page-header-copy">
        <h2 id={titleId}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? (
        <div className="fdy-page-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}
