import { ToastFeedback } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Issue, IssueQuestion } from "@bd777/foundry-protocol";
import { answerIssueQuestion } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";

/**
 * What the execution asked, with quick answers: Approve / Deny for a
 * permission, the Agent's suggested options for a decision. Any other answer
 * goes through the main chat.
 */
export function IssueQuestionCard({
  issue,
  question,
}: {
  issue: Issue;
  question: IssueQuestion;
}) {
  const { t } = useTranslation("issueDetail");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = issue.status === "blocked";
  const answers =
    question.kind === "permission"
      ? [t("question.approve"), t("question.deny")]
      : (question.options ?? []);
  const answer = async (text: string) => {
    setBusy(true);
    setError("");
    try {
      // The Issue arrives answered as its issue_updated event.
      await answerIssueQuestion(issue.id, question.id, text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert
      tone="warning"
      title={
        question.kind === "permission"
          ? t("question.permissionTitle")
          : t("question.inputTitle")
      }
    >
      <p>{question.text}</p>
      {answers.length ? (
        <div className="fdy-issue-question-answers">
          {answers.map((text, index) => (
            <Button
              key={text}
              disabled={busy || !ready}
              variant={index === 0 ? "primary" : "secondary"}
              onClick={() => void answer(text)}
            >
              {text}
            </Button>
          ))}
        </div>
      ) : null}
      <FieldHint>
        {ready ? t("question.answerHint") : t("question.finishingTurn")}
      </FieldHint>
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </Alert>
  );
}
