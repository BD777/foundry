import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import type { PersonalAgentItemReport } from "@bd777/foundry-protocol";
import { capturePersonalAgentInbox } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Subheading } from "../../components/ui/subheading";
import { Skeleton } from "../../components/ui/loading";
import { serverErrorText } from "../../lib/errors";
import { dateOnly } from "../../lib/time-format";
import {
  reportMarkdown,
  summaryHeadline,
  type ReportLabels,
} from "./items-model";
import { ownerLabel, stateLabel } from "./items-marks";

export interface ItemsReviewProps {
  assistantId?: string;
  report?: PersonalAgentItemReport;
  error: string;
  /** The range as the reader sees it. */
  rangeLabel: string;
  /** The one message 「请助理写成总结」 sends; the person clicks it. */
  askText: string;
  onBack: () => void;
  /** After the message is in the assistant's inbox. */
  onAsked: () => void;
}

/**
 * 「回顾」: what happened in a range, from the report's counts and the items
 * under each status. The report is data; the prose is the assistant's, asked
 * for by the person.
 */
export function ItemsReview({
  assistantId,
  report,
  error,
  rangeLabel,
  askText,
  onBack,
  onAsked,
}: ItemsReviewProps) {
  const { t } = useTranslation("personalAgent");
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const labels: ReportLabels = {
    title: t("items.review.title"),
    range: rangeLabel,
    counts: {
      created: t("items.review.counts.created"),
      done: t("items.review.counts.done"),
      open: t("items.review.counts.open"),
      dropped: t("items.review.counts.dropped"),
    },
    statuses: {
      open: t("items.status.open"),
      done: t("items.status.done"),
      dropped: t("items.status.dropped"),
    },
    owners: {
      person: t("items.card.you"),
      assistant: t("items.owner.assistant"),
    },
    updated: t("items.review.updated"),
    closed: t("items.review.closed"),
    empty: t("items.review.empty"),
  };

  const copy = async () => {
    if (!report) return;
    setActionError("");
    try {
      await navigator.clipboard.writeText(reportMarkdown(report, labels));
      setCopied(true);
    } catch (reason) {
      setActionError(serverErrorText(reason));
    }
  };

  const ask = async () => {
    setAsking(true);
    setActionError("");
    try {
      await capturePersonalAgentInbox(assistantId, {
        text: askText,
        messageId: crypto.randomUUID(),
      });
      onAsked();
    } catch (reason) {
      setActionError(serverErrorText(reason));
    } finally {
      setAsking(false);
    }
  };

  const populated = report?.groups.filter((group) => group.items.length > 0);
  return (
    <section
      aria-labelledby="fdy-items-review-title"
      className="grid content-start gap-5 px-5.5 py-4.5 max-[860px]:px-4"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ChevronLeft aria-hidden="true" size={14} />
          {t("items.review.back")}
        </Button>
        <h2
          className="text-xl leading-tight font-semibold text-ink"
          id="fdy-items-review-title"
        >
          {labels.title}
        </h2>
        <p className="text-sm text-ink-muted">{rangeLabel}</p>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button
            disabled={!report}
            onClick={() => void copy()}
            size="sm"
            variant="secondary"
          >
            {copied ? t("items.review.copied") : t("items.review.copy")}
          </Button>
          <Button
            disabled={!report || asking}
            onClick={() => void ask()}
            size="sm"
          >
            {t("items.review.ask")}
          </Button>
        </div>
      </header>
      {error ? (
        <Alert title={t("items.review.loadFailed")} tone="error">
          {error}
        </Alert>
      ) : null}
      {actionError ? (
        <Alert title={t("items.review.actionFailed")} tone="error">
          {actionError}
        </Alert>
      ) : null}
      {!report && !error ? <Skeleton label={t("loading")} rows={3} /> : null}
      {report ? (
        <>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {(["created", "done", "open", "dropped"] as const).map((key) => (
              <div className="grid gap-0.5" key={key}>
                <dt className="text-xs text-ink-muted">{labels.counts[key]}</dt>
                <dd className="text-xl font-semibold text-ink tabular-nums">
                  {report.counts[key]}
                </dd>
              </div>
            ))}
          </dl>
          {populated?.length === 0 ? (
            <p className="text-sm text-ink-muted">{labels.empty}</p>
          ) : null}
          {populated?.map((group) => (
            <section
              aria-label={labels.statuses[group.status]}
              className="grid gap-1.5"
              key={group.status}
            >
              <Subheading size="caption">
                {`${labels.statuses[group.status]} · ${group.items.length}`}
              </Subheading>
              <ul className="grid list-none gap-3">
                {group.items.map((item) => {
                  const headline = summaryHeadline(item.summary);
                  return (
                    <li className="grid gap-0.5" key={item.id}>
                      <strong className="text-sm font-semibold text-ink">
                        {item.text}
                      </strong>
                      <span className="text-xs text-ink-faint">
                        {[
                          ownerLabel(item.owner, t),
                          stateLabel(item, t),
                          `${labels.updated} ${dateOnly(item.updatedAt)}`,
                          item.closedAt
                            ? `${labels.closed} ${dateOnly(item.closedAt)}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {headline ? (
                        <p className="text-sm text-ink-muted">{headline}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      ) : null}
    </section>
  );
}
