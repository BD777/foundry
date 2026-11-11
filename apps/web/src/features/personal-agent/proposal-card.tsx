import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonalAgentProposal } from "@bd777/foundry-protocol";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { PaMuted } from "./pa-muted";
import { ButtonRow } from "../../components/ui/button-row";

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

interface ConnectorWriteSpec {
  accountId?: unknown;
  accountName?: unknown;
  connector?: unknown;
}

function connectorAccountName(proposal: PersonalAgentProposal): string {
  if (proposal.kind !== "connector_write") return "";
  const spec =
    proposal.spec && typeof proposal.spec === "object"
      ? (proposal.spec as ConnectorWriteSpec)
      : {};
  if (typeof spec.accountName === "string" && spec.accountName.trim())
    return spec.accountName.trim();
  if (typeof spec.connector === "string" && spec.connector.trim()) {
    const connector = spec.connector.trim();
    return connector.charAt(0).toUpperCase() + connector.slice(1);
  }
  return typeof spec.accountId === "string" ? spec.accountId.trim() : "";
}

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
  const connectorAccount = connectorAccountName(proposal);

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
      className="grid gap-2 rounded-lg bg-panel px-3.5 py-3 shadow-hairline"
      data-status={proposal.status}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
        <span className="text-xs font-semibold text-ink-muted">
          {t("proposal.kicker")}
        </span>
        <Badge tone={statusTone[proposal.status]}>
          {t(`proposal.status.${proposal.status}`)}
        </Badge>
      </header>
      <p className="text-md leading-[1.55] wrap-anywhere text-ink">
        {proposal.summary}
      </p>
      {connectorAccount ? (
        <p className="m-0 text-xs leading-[1.5] text-ink-muted wrap-anywhere">
          <span className="font-semibold">{t("proposal.account")}:</span>{" "}
          {connectorAccount}
        </p>
      ) : null}
      {proposal.status === "failed" && proposal.error ? (
        <PaMuted>{proposal.error}</PaMuted>
      ) : null}
      {pending ? (
        <>
          <ButtonRow>
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
          </ButtonRow>
          <PaMuted
            className="leading-[1.65]"
            title={fullWhen(proposal.expiresAt)}
          >
            {t("proposal.expires", { when: relativeWhen(proposal.expiresAt) })}
          </PaMuted>
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
