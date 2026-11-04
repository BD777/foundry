import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { SectionLabel } from "../../components/ui/panel";

export interface ReviewDiffFile {
  added: string;
  path: string;
  removed?: string;
}

export interface ReviewCompareProps extends HTMLAttributes<HTMLElement> {
  baselineLabel: ReactNode;
  candidateLabel: ReactNode;
  files?: ReviewDiffFile[];
}

const swatchTone = {
  baseline: "bg-line-strong",
  candidate: "bg-warning-text",
} as const;

function CompareKey({
  children,
  tone,
}: {
  children: ReactNode;
  tone: keyof typeof swatchTone;
}) {
  return (
    <span className="inline-flex min-w-0 flex-none items-center gap-1.5 text-2xs leading-none font-medium whitespace-nowrap text-ink-faint">
      <span
        className={cn("inline-block size-2.5 rounded-xs", swatchTone[tone])}
        data-tone={tone}
      />
      {children}
    </span>
  );
}

const skeletonBar = "block min-w-0 rounded-xs bg-line";
const skeletonGrid = "grid min-w-0 grid-cols-2 gap-2.25";
const skeletonCell = "block h-12 min-w-0 rounded-sm border border-line bg-line";

function PreviewFrame({
  label,
  meta,
  tone,
}: {
  label: ReactNode;
  meta: ReactNode;
  tone: keyof typeof swatchTone;
}) {
  const { t } = useTranslation("issueDetail");
  const isCandidate = tone === "candidate";

  return (
    <div
      className={cn(
        "box-border min-w-0 overflow-hidden rounded-lg border bg-panel",
        isCandidate ? "border-accent-line shadow-drop" : "border-line",
      )}
      data-tone={tone}
    >
      <div
        className={cn(
          "box-border flex min-h-7 min-w-0 items-center gap-1.75 border-b px-2.75 py-2 text-2xs leading-none font-semibold",
          isCandidate
            ? "border-warning-border bg-panel-soft text-warning-text"
            : "border-line-soft bg-surface text-ink-muted",
        )}
      >
        <span
          className={cn("inline-block size-2 rounded-full", swatchTone[tone])}
          data-tone={tone}
        />
        {label}
        <code
          className={cn(
            "ml-auto min-w-0 truncate font-mono text-2xs leading-tight font-medium",
            isCandidate ? "text-warning-text" : "text-ink-faint",
          )}
        >
          {meta}
        </code>
      </div>
      <div
        className={cn(
          "box-border min-w-0 p-3.5",
          isCandidate ? "bg-panel" : "bg-surface",
        )}
        data-tone={tone}
      >
        <span className={cn(skeletonBar, "mb-2.25 h-[9px] w-[52%]")} />
        <span className={cn(skeletonBar, "mb-1.5 h-1.5 w-[78%]")} />
        <span className={cn(skeletonBar, "mb-1.5 h-1.5 w-[64%]")} />
        {isCandidate ? (
          <div className="mt-3.5 min-w-0 rounded-sm border-[1.5px] border-dashed border-warning-border bg-warning-surface p-2">
            <strong className="mb-1.75 block text-2xs leading-none font-semibold text-warning-text uppercase">
              {t("compare.new")}
            </strong>
            <div className={skeletonGrid}>
              <span className={cn(skeletonCell, "h-8.5 bg-warning-surface")} />
              <span className={cn(skeletonCell, "h-8.5 bg-warning-surface")} />
            </div>
          </div>
        ) : (
          <div className={cn(skeletonGrid, "mt-3.5")}>
            <span className={skeletonCell} />
            <span className={skeletonCell} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ReviewCompare({
  baselineLabel,
  candidateLabel,
  className,
  files,
  ...props
}: ReviewCompareProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <section
      className={cn("mb-5.5 w-full max-w-[760px] min-w-0", className)}
      {...props}
    >
      <div className="mb-3 flex min-w-0 items-center gap-2.5 max-[860px]:flex-wrap max-[860px]:items-start max-[860px]:gap-y-2">
        <SectionLabel className="mr-auto mb-2 max-[860px]:mr-0 max-[860px]:w-full">
          {t("compare.title")}
        </SectionLabel>
        <CompareKey tone="baseline">{t("compare.baseline")}</CompareKey>
        <CompareKey tone="candidate">{t("compare.candidate")}</CompareKey>
      </div>
      <div className="mb-5.5 grid w-full min-w-0 grid-cols-2 gap-3.5 max-[860px]:grid-cols-1">
        <PreviewFrame
          label={t("compare.baseline")}
          meta={baselineLabel}
          tone="baseline"
        />
        <PreviewFrame
          label={t("compare.candidate")}
          meta={candidateLabel}
          tone="candidate"
        />
      </div>
      {files && files.length > 0 ? (
        <>
          <SectionLabel className="mb-2.25">{t("compare.files")}</SectionLabel>
          <div
            className="box-border max-w-full min-w-0 overflow-x-hidden rounded-lg bg-(--fdy-dark-surface) bg-clip-padding px-4 py-3.5 font-mono text-xs leading-[1.9] font-medium text-(--fdy-dark-text) max-[860px]:px-3.5 max-[860px]:py-3.25"
            aria-label={t("compare.changedFiles")}
          >
            {files.map((file) => (
              <div
                className="flex min-h-[22px] w-full min-w-0 items-center gap-2.5 text-(--fdy-dark-text) max-[860px]:grid max-[860px]:grid-cols-[minmax(0,1fr)_38px_34px] max-[860px]:items-start max-[860px]:gap-x-2 max-[860px]:gap-y-1 max-[860px]:py-0.5"
                key={file.path}
              >
                <span className="min-w-0 flex-1 truncate max-[860px]:overflow-visible max-[860px]:text-clip max-[860px]:whitespace-normal max-[860px]:wrap-anywhere">
                  {file.path}
                </span>
                <b className="min-w-[38px] flex-none text-right font-semibold text-(--fdy-diff-added) tabular-nums">
                  {file.added}
                </b>
                <i className="min-w-[34px] flex-none text-right text-(--fdy-diff-removed) tabular-nums not-italic">
                  {file.removed ?? ""}
                </i>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
