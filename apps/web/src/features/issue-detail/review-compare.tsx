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

function CompareKey({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className="fdy-compare-key">
      <span className="fdy-compare-swatch" data-tone={tone} />
      {children}
    </span>
  );
}

function PreviewFrame({
  label,
  meta,
  tone,
}: {
  label: ReactNode;
  meta: ReactNode;
  tone: "baseline" | "candidate";
}) {
  const { t } = useTranslation("issueDetail");
  const isCandidate = tone === "candidate";

  return (
    <div className="fdy-preview-frame" data-tone={tone}>
      <div className="fdy-preview-frame-bar">
        <span className="fdy-compare-swatch" data-tone={tone} />
        {label}
        <code>{meta}</code>
      </div>
      <div className="fdy-preview-skeleton" data-tone={tone}>
        <span className="fdy-skel-title" />
        <span className="fdy-skel-line fdy-skel-line-wide" />
        <span className="fdy-skel-line" />
        {isCandidate ? (
          <div className="fdy-candidate-change">
            <strong>{t("compare.new")}</strong>
            <div className="fdy-skel-grid">
              <span />
              <span />
            </div>
          </div>
        ) : (
          <div className="fdy-skel-grid">
            <span />
            <span />
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
      className={cn("fdy-detail-block fdy-review-compare", className)}
      {...props}
    >
      <div className="fdy-compare-heading">
        <SectionLabel>{t("compare.title")}</SectionLabel>
        <CompareKey tone="baseline">{t("compare.baseline")}</CompareKey>
        <CompareKey tone="candidate">{t("compare.candidate")}</CompareKey>
      </div>
      <div className="fdy-compare-grid">
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
          <SectionLabel>{t("compare.files")}</SectionLabel>
          <div className="fdy-file-diff" aria-label={t("compare.changedFiles")}>
            {files.map((file) => (
              <div className="fdy-file-diff-row" key={file.path}>
                <span>{file.path}</span>
                <b>{file.added}</b>
                <i>{file.removed ?? ""}</i>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
