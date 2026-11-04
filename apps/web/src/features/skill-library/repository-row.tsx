import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { RowCard } from "../../components/ui/row-card";
import { cn } from "../../lib/cn";

/**
 * The parts of a followed or recommended repository's card: the card with
 * its text column and its actions beside it (beneath it when narrow).
 */
export function RepositoryRow({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
  return (
    <RowCard
      as="li"
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 px-3.25 py-2.75 max-[640px]:grid-cols-1",
        className,
      )}
      {...props}
    >
      {children}
    </RowCard>
  );
}

export function RepositoryCopy({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid min-w-0 gap-1", className)} {...props} />;
}

/** One suggested action and the "…" menu; the text keeps the rest. */
export function RepositoryButtons({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1.5 max-[640px]:justify-start",
        className,
      )}
      {...props}
    />
  );
}

/** The repository's name, a link to its page when it has one. */
export function RepositoryName({
  children,
  href,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
}) {
  return href ? (
    <a
      className="font-semibold text-ink [overflow-wrap:anywhere]"
      href={href}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/** What follows a name: its version or how many skills it took. */
export function RepositoryVersion({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("text-sm text-ink-muted", className)} {...props} />
  );
}

/** The repository's own description, from its host. */
export function RepositoryDescription({
  as: Component = "p",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "p" | "span" }) {
  return (
    <Component
      className={cn("line-clamp-2 text-sm [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}
