import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonalAgentProposal } from "@bd777/foundry-protocol";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";

const statusTone: Record<
  PersonalAgentProposal["status"],
  NonNullable<BadgeProps["tone"]>
> = {
  pending: "brass",
  accepted: "online",
  applied: "online",
  declined: "neutral",
  expired: "neutral",
  failed: "error",
};

/**
 * Something the assistant wants to do and the person's rules say to ask
 * about first. Only the person answers it here (their sign-in); a decided
 * one stays in the conversation with what became of it.
 */
export function ProposalCard({
  proposal,
  onAnswer,
}: {
  proposal: PersonalAgentProposal;
  onAnswer: (accept: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("personalAgent");
  const [busy, setBusy] = useState<"accept" | "decline">();
  const [error, setError] = useState("");
  const pending = proposal.status === "pending";

  async function answer(accept: boolean): Promise<void> {
    setBusy(accept ? "accept" : "decline");
    setError("");
    try {
      await onAnswer(accept);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section
      aria-label={t("proposal.kicker")}
      className="fdy-pa-proposal"
      data-status={proposal.status}
    >
      <header className="fdy-pa-proposal-head">
        <span className="fdy-pa-proposal-kicker">{t("proposal.kicker")}</span>
        <Badge tone={statusTone[proposal.status]}>
          {t(`proposal.status.${proposal.status}`)}
        </Badge>
      </header>
      <p className="fdy-pa-proposal-summary">{proposal.summary}</p>
      {proposal.status === "failed" && proposal.error ? (
        <p className="fdy-pa-proposal-note">{proposal.error}</p>
      ) : null}
      {pending ? (
        <>
          <div className="fdy-pa-proposal-actions">
            <Button
              aria-busy={busy === "accept"}
              disabled={Boolean(busy)}
              onClick={() => void answer(true)}
              size="sm"
              variant="primary"
            >
              {t("proposal.accept")}
            </Button>
            <Button
              aria-busy={busy === "decline"}
              disabled={Boolean(busy)}
              onClick={() => void answer(false)}
              size="sm"
              variant="secondary"
            >
              {t("proposal.decline")}
            </Button>
          </div>
          <p
            className="fdy-pa-proposal-note"
            title={fullWhen(proposal.expiresAt)}
          >
            {t("proposal.expires", { when: relativeWhen(proposal.expiresAt) })}
          </p>
        </>
      ) : null}
      {error ? (
        <ToastFeedback tone="error" title={t("proposal.answerFailed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </section>
  );
}
