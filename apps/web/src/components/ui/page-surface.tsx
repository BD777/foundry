import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type PageSurfaceVariant =
  | "accounts"
  | "archive"
  | "assets"
  | "connectors"
  | "devices"
  | "library"
  | "members"
  | "pending"
  | "profiles"
  | "resources"
  | "settings"
  | "skills"
  | "workspace";

export interface PageSurfaceProps extends HTMLAttributes<HTMLElement> {
  variant: PageSurfaceVariant;
  embedded?: boolean;
}

/*
 * A page: one column on the sheet. Every page has the same width, padding and
 * rhythm, so a heading sits in the same place on every page; a page that is
 * only a form takes the narrow width.
 */
export function PageSurface({
  children,
  className,
  variant,
  embedded = false,
  ...props
}: PageSurfaceProps) {
  return (
    <section
      className={cn(
        embedded
          ? "fdy-page-embedded grid min-w-0 grid-cols-[minmax(0,1fr)] gap-(--fdy-page-gap)"
          : [
              "fdy-page-surface mx-auto flex min-h-full w-full max-w-(--fdy-page-width) min-w-0 animate-page-fade flex-col gap-(--fdy-page-gap) overflow-visible px-8 pt-7 pb-14 max-[860px]:px-4 max-[860px]:pt-5 max-[860px]:pb-10 [&>*]:shrink-0",
              `fdy-page-surface-${variant}`,
              variant === "accounts" && "max-w-(--fdy-page-width-narrow)",
            ],
        className,
      )}
      data-foundry-scroll-reset="true"
      {...props}
    >
      {children}
    </section>
  );
}
