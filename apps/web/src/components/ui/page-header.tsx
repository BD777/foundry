import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

const headerClass =
  "flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3";
const copyClass = "fdy-page-header-copy min-w-0 flex-[1_1_18rem]";
const descriptionClass =
  "mt-1 max-w-[72ch] text-sm leading-[1.55] text-ink-muted";
const actionsClass =
  "fdy-page-header-actions flex flex-wrap items-center gap-2";

export interface PageHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the heading's far side; they wrap beneath it when narrow. */
  actions?: ReactNode;
  /** A HelpHint beside the title: how this page works, never a trailing paragraph. */
  help?: ReactNode;
}

/** The one heading of a page: title, a line of what it is for, its actions. */
export function PageHeader({
  actions,
  className,
  description,
  help,
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header
      className={cn("fdy-page-header", headerClass, className)}
      {...props}
    >
      <div className={copyClass}>
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="text-2xl leading-[1.25] font-semibold text-ink [overflow-wrap:anywhere]">
            {title}
          </h1>
          {help}
        </div>
        {description ? (
          <p className={cn(descriptionClass, "mt-1.5")}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className={actionsClass}>{actions}</div> : null}
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
  /** A HelpHint beside the title: how this section works, never a trailing paragraph. */
  help?: ReactNode;
  /** Id of the title, for the section's `aria-labelledby`. */
  titleId?: string;
  /** A sub-section (heading level 3, a step smaller) inside a section or dialog. */
  level?: 2 | 3;
}

/** The heading of a section inside a page: same shape, one level down. */
export function SectionHeader({
  actions,
  className,
  description,
  help,
  level = 2,
  title,
  titleId,
  ...props
}: SectionHeaderProps) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <header
      className={cn("fdy-section-header", headerClass, className)}
      {...props}
    >
      <div className={copyClass}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Heading
            className={
              level === 3
                ? "text-md leading-[1.3] font-semibold text-ink"
                : "text-xl leading-[1.3] font-semibold text-ink"
            }
            id={titleId}
          >
            {title}
          </Heading>
          {help}
        </div>
        {description ? <p className={descriptionClass}>{description}</p> : null}
      </div>
      {actions ? <div className={actionsClass}>{actions}</div> : null}
    </header>
  );
}
