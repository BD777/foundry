import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type PageSurfaceVariant =
  | "accounts"
  | "assets"
  | "devices"
  | "profiles"
  | "runs"
  | "settings"
  | "skills"
  | "workspace";

export interface PageSurfaceProps extends HTMLAttributes<HTMLElement> {
  variant: PageSurfaceVariant;
  embedded?: boolean;
}

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
        embedded ? "fdy-page-embedded" : "fdy-page-surface",
        !embedded && `fdy-page-surface-${variant}`,
        className,
      )}
      data-foundry-scroll-reset="true"
      {...props}
    >
      {children}
    </section>
  );
}

export function HelperCopy({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("fdy-helper-copy", className)} {...props} />;
}
