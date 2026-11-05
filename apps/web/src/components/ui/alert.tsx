import { cva } from "class-variance-authority";
import { CircleAlert, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

/*
 * After shadcn/ui's Alert: a bordered status surface with an icon and a
 * title. The tones are Foundry's status tokens, a paired foreground and
 * background for both themes.
 */
const alertVariants = cva(
  "fdy-alert flex w-full items-start border [&>svg]:mt-0.5 [&>svg]:flex-none",
  {
    variants: {
      tone: {
        info: "border-info-border bg-info-surface text-info-text",
        success: "border-success-border bg-success-surface text-success-text",
        warning: "border-warning-border bg-warning-surface text-warning-text",
        error: "border-error-border bg-error-surface text-error-text",
      },
      size: {
        default: "gap-2.5 rounded-lg px-3.5 py-3 text-sm leading-[1.55]",
        compact: "gap-2 rounded-lg px-2.5 py-2 text-xs leading-[1.55]",
      },
    },
    defaultVariants: { tone: "info", size: "default" },
  },
);

/**
 * Status surface with a paired foreground/background for both themes. A
 * warning or error interrupts a screen reader (`role="alert"`); give a notice
 * that is simply part of the page `role="status"`.
 */
export function Alert({
  tone = "info",
  title,
  size = "default",
  children,
  details,
  actions,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  tone?: "info" | "success" | "warning" | "error";
  title: ReactNode;
  size?: "default" | "compact";
  details?: ReactNode;
  /** Buttons that answer the notice (Retry, Reconnect), inside it, under its text. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("ui");
  const Icon = tone === "info" || tone === "success" ? Info : CircleAlert;
  return (
    <section
      className={cn(alertVariants({ size, tone }), className)}
      data-tone={tone}
      data-size={size}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      {...props}
    >
      <Icon size={17} aria-hidden="true" />
      <div className="fdy-alert-content min-w-0 flex-1 [overflow-wrap:anywhere]">
        <strong className="block text-inherit">{title}</strong>
        {children != null ? (
          <div className="fdy-alert-body mt-1">{children}</div>
        ) : null}
        {actions ? (
          <div className="fdy-alert-actions mt-2 flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
        {details ? (
          <details className="mt-2">
            <summary className="cursor-pointer">
              {t("alert.diagnosticDetails")}
            </summary>
            <div className="fdy-alert-diagnostic mt-2 whitespace-pre-wrap">
              {details}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
