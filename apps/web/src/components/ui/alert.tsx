import { CircleAlert, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

/** Status surface with a paired foreground/background for both themes. */
export function Alert({
  tone = "info",
  title,
  size = "default",
  children,
  details,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  tone?: "info" | "success" | "warning" | "error";
  title: ReactNode;
  size?: "default" | "compact";
  details?: ReactNode;
}) {
  const { t } = useTranslation("ui");
  const Icon = tone === "info" || tone === "success" ? Info : CircleAlert;
  return (
    <section
      className={cn("fdy-alert", className)}
      data-tone={tone}
      data-size={size}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      {...props}
    >
      <Icon size={17} aria-hidden="true" />
      <div className="fdy-alert-content">
        <strong>{title}</strong>
        {children != null ? (
          <div className="fdy-alert-body">{children}</div>
        ) : null}
        {details ? (
          <details>
            <summary>{t("alert.diagnosticDetails")}</summary>
            <div className="fdy-alert-diagnostic">{details}</div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
