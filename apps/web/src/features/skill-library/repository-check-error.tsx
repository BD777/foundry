import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { checkErrorReason } from "../../lib/bundle-versions";

/**
 * Why the last check of a repository failed, in one line with what to do;
 * the tool's own output waits behind Details, scrollable and in mono.
 */
export function RepositoryCheckError({
  error,
  busy,
  onRetry,
}: {
  error: string;
  busy?: boolean;
  /** Checks again; absent for people who cannot. */
  onRetry?: () => void;
}) {
  const { t } = useTranslation("skills");
  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 gap-y-1 text-xs"
      role="alert"
    >
      <span
        className={
          onRetry
            ? "flex h-[27px] items-center text-error-text"
            : "flex h-4 items-center text-error-text"
        }
      >
        <CircleAlert aria-hidden="true" size={14} />
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 text-error-text [overflow-wrap:anywhere]">
          {t("library.repo.checkFailedLine", {
            reason: checkErrorReason(error),
          })}
        </span>
        {onRetry ? (
          <Button
            aria-busy={busy}
            disabled={busy}
            onClick={onRetry}
            size="sm"
            variant="secondary"
          >
            {t("library.repo.checkAgain")}
          </Button>
        ) : null}
      </div>
      <Disclosure className="col-start-2">
        <DisclosureSummary>{t("library.repo.checkDetails")}</DisclosureSummary>
        <pre className="m-0 max-h-40 overflow-auto rounded-sm bg-inset p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
          {error}
        </pre>
      </Disclosure>
    </div>
  );
}
