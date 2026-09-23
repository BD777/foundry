import { CircleAlert, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Status surface with a paired foreground/background for both themes. */
export function Alert({
  tone = "info",
  title,
  children,
  details,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  tone?: "info" | "success" | "warning" | "error";
  title: ReactNode;
  details?: ReactNode;
}) {
  const Icon = tone === "info" || tone === "success" ? Info : CircleAlert;
  return (
    <section
      className={cn("fdy-alert", className)}
      data-tone={tone}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      {...props}
    >
      <Icon size={17} aria-hidden="true" />
      <div className="fdy-alert-content">
        <strong>{title}</strong>
        <div>{children}</div>
        {details ? (
          <details>
            <summary>Diagnostic details</summary>
            <div className="fdy-alert-diagnostic">{details}</div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
