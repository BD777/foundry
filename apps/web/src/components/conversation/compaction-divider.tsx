import type { AgentContextCompaction } from "@bd777/foundry-protocol";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { clockTime } from "../../lib/time-format";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { formatTokenCount } from "./turn-usage";

/** The divider's label and, with a summary, its toggle. */
const labelClass =
  "inline-flex min-w-0 max-w-[min(620px,100%)] flex-wrap items-center justify-center gap-x-1.5 gap-y-[3px] text-center text-xs leading-[1.45] text-ink-faint";

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
      <strong className="font-[650]">{t("compaction.title")}</strong>
      <span className="tabular-nums">{facts}</span>
    </>
  );
  return (
    <div
      className="fdy-chat-compaction my-1 grid w-full gap-2"
      data-open={open && summary ? "true" : "false"}
    >
      <div className="grid grid-cols-[minmax(24px,1fr)_auto_minmax(24px,1fr)] items-center gap-2.5 text-ink-faint">
        <span aria-hidden="true" className="h-px bg-line" />
        {summary ? (
          <Button
            aria-controls={open ? id : undefined}
            aria-expanded={open}
            className={cn(
              "fdy-chat-compaction-toggle h-auto min-h-[26px] px-2 py-0.5 hover:text-ink aria-expanded:text-ink",
              labelClass,
            )}
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
          <span
            className={cn("fdy-chat-compaction-label", labelClass)}
            role="note"
          >
            {label}
          </span>
        )}
        <span aria-hidden="true" className="h-px bg-line" />
      </div>
      {open && summary ? (
        <section
          aria-label={t("compaction.summary")}
          className="fdy-chat-compaction-summary grid max-h-[360px] gap-1.5 overflow-auto rounded-xl bg-panel px-3 py-2.5 shadow-card"
          id={id}
        >
          <header className="flex items-center justify-between gap-2 text-xs font-[650] text-ink-faint">
            <span>{t("compaction.summary")}</span>
            <CopyButton
              copiedLabel={t("compaction.copied")}
              label={t("compaction.copySummary")}
              text={summary}
              title={t("compaction.copySummary")}
            />
          </header>
          <p className="fdy-chat-compaction-summary-text text-sm leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink">
            {summary}
          </p>
        </section>
      ) : null}
    </div>
  );
}
