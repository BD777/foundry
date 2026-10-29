import type { AgentContextCompaction } from "@bd777/foundry-protocol";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { clockTime } from "../../lib/time-format";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { formatTokenCount } from "./turn-usage";

/**
 * "Auto · 951.8K → 38.2K tokens · 17:01": what a compaction's divider says,
 * with whatever the runtime reported.
 */
export function compactionFacts(
  compaction: AgentContextCompaction,
  at: string | undefined,
  t: TFunction<"conversation">,
): string {
  const { preTokens, postTokens } = compaction;
  const tokens =
    preTokens && postTokens
      ? t("compaction.tokens", {
          before: formatTokenCount(preTokens),
          after: formatTokenCount(postTokens),
        })
      : preTokens
        ? t("compaction.tokensBefore", { before: formatTokenCount(preTokens) })
        : postTokens
          ? t("compaction.tokensAfter", { after: formatTokenCount(postTokens) })
          : "";
  return [
    t(
      compaction.trigger === "manual" ? "compaction.manual" : "compaction.auto",
    ),
    tokens,
    clockTime(at, { date: "short" }),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Where the agent's context was compacted (DEV-083): a divider at that
 * point of the transcript. The summary the agent continued from, when the
 * runtime keeps a readable one, opens under it.
 */
export function CompactionDivider({
  compaction,
  at,
}: {
  compaction: AgentContextCompaction;
  at?: string;
}) {
  const { t } = useTranslation("conversation");
  const [open, setOpen] = useState(false);
  const id = useId();
  const facts = compactionFacts(compaction, at, t);
  const summary = compaction.summary?.trim();
  const label = (
    <>
      <Layers aria-hidden="true" size={13} />
      <strong>{t("compaction.title")}</strong>
      <span className="fdy-chat-compaction-facts">{facts}</span>
    </>
  );
  return (
    <div
      className="fdy-chat-compaction"
      data-open={open && summary ? "true" : "false"}
    >
      <div className="fdy-chat-compaction-rule">
        <span aria-hidden="true" className="fdy-chat-compaction-line" />
        {summary ? (
          <Button
            aria-controls={open ? id : undefined}
            aria-expanded={open}
            className="fdy-chat-compaction-toggle"
            onClick={() => setOpen(!open)}
            size="sm"
            title={
              open ? t("compaction.hideSummary") : t("compaction.showSummary")
            }
            variant="ghost"
          >
            {label}
            {open ? (
              <ChevronDown aria-hidden="true" size={13} />
            ) : (
              <ChevronRight aria-hidden="true" size={13} />
            )}
          </Button>
        ) : (
          <span className="fdy-chat-compaction-label" role="note">
            {label}
          </span>
        )}
        <span aria-hidden="true" className="fdy-chat-compaction-line" />
      </div>
      {open && summary ? (
        <section
          aria-label={t("compaction.summary")}
          className="fdy-chat-compaction-summary"
          id={id}
        >
          <header className="fdy-chat-compaction-summary-head">
            <span>{t("compaction.summary")}</span>
            <CopyButton
              copiedLabel={t("compaction.copied")}
              label={t("compaction.copySummary")}
              text={summary}
              title={t("compaction.copySummary")}
            />
          </header>
          <p className="fdy-chat-compaction-summary-text">{summary}</p>
        </section>
      ) : null}
    </div>
  );
}
