import { ChevronDown, ChevronUp, MessageCircleQuestion } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { AgentQuestion } from "@bd777/foundry-protocol";
import { cn } from "../../lib/cn";
import { Badge, type BadgeProps } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldHint, Radio, TextInput } from "../ui/field";
import { agentQuestionReplyText } from "./agent-questions";
import type { ConversationQuestionState } from "./conversation-types";

const other = "other";

/** A name and what was answered under it. */
const answersClass = "m-0 grid gap-1.5";
const answerLabelClass = "text-xs leading-[1.4] text-ink-muted";
const answerValueClass =
  "m-0 text-sm leading-[1.45] font-[550] wrap-anywhere text-ink";

/** One choice: the radio, its text, and what picks it out (checked, focus). */
const optionClass =
  "flex min-w-0 cursor-pointer items-center gap-[9px] rounded-sm px-2 py-1.5 text-sm leading-[1.4] text-ink hover:bg-control-ghost-hover has-[:checked]:bg-accent-tint has-[:checked]:font-[550] has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-(--fdy-accent)";

const stateTones: Record<
  ConversationQuestionState | "sent",
  BadgeProps["tone"]
> = {
  waiting: "brass",
  answered: "online",
  sent: "online",
  assumed: "warn",
  unanswered: "neutral",
};

/**
 * The questions an Agent asked without waiting (Codex async questions):
 * choices, the person's own answer, and where they stand. Open while the
 * Agent waits; otherwise collapsed to "Answer", which reopens it.
 */
export function AgentQuestionCard({
  active,
  answers,
  itemId,
  onAnswer,
  questions,
  state,
}: {
  /** A turn runs: the answer goes into it, not into the next one. */
  active: boolean;
  answers?: string[];
  itemId: string;
  /** Sends the reply text once per `key`; why it failed, if it did. */
  onAnswer?: (text: string, key: string) => Promise<string | undefined>;
  questions: AgentQuestion[];
  state: ConversationQuestionState;
}) {
  const { t } = useTranslation("conversation");
  const groupId = useId();
  const [open, setOpen] = useState(state === "waiting");
  const [choices, setChoices] = useState<string[]>(() =>
    questions.map((question) => (question.options?.length ? "0" : other)),
  );
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<string[]>();
  const card = useRef<HTMLElement>(null);
  // Open while the Agent waits; collapsed once it stops waiting, unless
  // the person is answering in it right now.
  useEffect(() => {
    if (state === "waiting") setOpen(true);
    else if (!card.current?.contains(document.activeElement)) setOpen(false);
  }, [state]);
  const shown = state === "answered" ? "answered" : sent ? "sent" : state;
  const given = state === "answered" ? (answers ?? []) : (sent ?? []);
  const answerOf = (index: number) => {
    const question = questions[index]!;
    const choice = choices[index];
    return choice === other || !question.options?.length
      ? (texts[index] ?? "").trim()
      : (question.options[Number(choice)] ?? "");
  };
  const choose = (index: number, value: string) =>
    setChoices((current) =>
      current.map((choice, at) => (at === index ? value : choice)),
    );
  const type = (index: number, value: string) =>
    setTexts((current) =>
      current.map((text, at) => (at === index ? value : text)),
    );
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !onAnswer) return;
    const values = questions.map((_, index) => answerOf(index));
    if (!values.some(Boolean)) {
      setError(t("question.empty"));
      return;
    }
    setBusy(true);
    setError("");
    const failure = await onAnswer(
      agentQuestionReplyText(itemId, questions, values),
      `question:${itemId}`,
    );
    setBusy(false);
    if (failure) setError(failure);
    else setSent(values);
  };
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (target.type !== "radio") return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    // A digit picks that option of the focused question.
    const index = Number(target.dataset.question);
    const options = questions[index]?.options ?? [];
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      event.preventDefault();
      choose(index, String(digit - 1));
    }
  };
  return (
    <section
      aria-label={t("question.title")}
      className={cn(
        "fdy-chat-question grid max-w-[640px] gap-2.5 rounded-xl bg-inset px-4 py-3.5",
        shown === "waiting" &&
          "bg-surface shadow-[0_0_0_1px_var(--fdy-accent-line),var(--shadow-md)]",
      )}
      ref={card}
      data-state={shown}
    >
      <div className="flex flex-wrap items-center gap-[7px] text-xs leading-[1.3] text-ink">
        <MessageCircleQuestion
          aria-hidden="true"
          className="flex-none text-brand-dark"
          size={15}
        />
        <strong className="font-[650]">{t("question.title")}</strong>
        <Badge tone={stateTones[shown]}>{t(`question.state.${shown}`)}</Badge>
      </div>
      {given.length ? (
        <dl className={answersClass}>
          {questions.map((question, index) =>
            given[index] ? (
              <div className="grid min-w-0 gap-0.5" key={index}>
                <dt className={answerLabelClass}>{question.title}</dt>
                <dd className={answerValueClass}>{given[index]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : open ? (
        <form className="grid gap-3" onKeyDown={keys} onSubmit={submit}>
          {questions.map((question, index) => (
            <fieldset
              className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
              key={index}
            >
              <legend className="mb-1.5 p-0 text-md leading-normal font-semibold text-ink">
                {question.title}
              </legend>
              {question.options?.length ? (
                <div className="grid gap-0.5">
                  {question.options.map((option, at) => (
                    <label className={optionClass} key={at}>
                      <Radio
                        className="flex-none"
                        checked={choices[index] === String(at)}
                        data-question={index}
                        name={`${groupId}-${index}`}
                        onChange={() => choose(index, String(at))}
                        value={String(at)}
                      />
                      <span className="min-w-0 wrap-anywhere">{option}</span>
                      {at === 0 ? (
                        <small className="ml-auto flex-none text-2xs font-[550] text-ink-faint">
                          {t("question.recommended")}
                        </small>
                      ) : null}
                    </label>
                  ))}
                  <label className={optionClass}>
                    <Radio
                      className="flex-none"
                      checked={choices[index] === other}
                      data-question={index}
                      name={`${groupId}-${index}`}
                      onChange={() => choose(index, other)}
                      value={other}
                    />
                    <span className="min-w-0 wrap-anywhere">
                      {t("question.other")}
                    </span>
                  </label>
                  {choices[index] === other ? (
                    <TextInput
                      aria-label={t("question.other")}
                      className="mt-1 ml-[31px] w-[calc(100%-31px)]"
                      autoFocus
                      onChange={(event) => type(index, event.target.value)}
                      placeholder={t("question.otherPlaceholder")}
                      tone="boxed"
                      value={texts[index]}
                    />
                  ) : null}
                </div>
              ) : (
                <TextInput
                  aria-label={t("question.freeText")}
                  onChange={(event) => type(index, event.target.value)}
                  placeholder={t("question.otherPlaceholder")}
                  tone="boxed"
                  value={texts[index]}
                />
              )}
            </fieldset>
          ))}
          <div className="grid gap-2">
            <FieldHint>
              {state === "waiting" ? null : `${t("question.assumedHint")} `}
              {active ? t("question.intoTurn") : t("question.nextTurn")}{" "}
              {t("question.shortcuts")}
            </FieldHint>
            {error ? (
              <FieldHint role="alert" tone="error">
                {error}
              </FieldHint>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
                <ChevronUp aria-hidden="true" size={13} />
                {t("question.collapse")}
              </Button>
              <Button
                aria-busy={busy}
                disabled={busy || !onAnswer}
                size="sm"
                type="submit"
                variant="primary"
              >
                {busy ? t("question.sending") : t("question.send")}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 flex-1 truncate text-xs leading-[1.4] text-ink-muted">
            {questions.map((question) => question.title).join(" · ")}
          </span>
          <Button
            className="flex-none"
            disabled={!onAnswer}
            onClick={() => setOpen(true)}
            size="sm"
            variant="secondary"
          >
            <ChevronDown aria-hidden="true" size={13} />
            {t("question.answer")}
          </Button>
        </div>
      )}
    </section>
  );
}

/** A user message that answered questions: what it answered. */
export function AgentQuestionReplyView({
  replies,
}: {
  replies: { question: string; answer: string }[];
}) {
  const { t } = useTranslation("conversation");
  return (
    <div className="grid gap-1.5">
      <span className="inline-flex items-center gap-[5px] text-2xs font-[550] text-ink-faint">
        <MessageCircleQuestion aria-hidden="true" size={13} />
        {t("question.repliedTo")}
      </span>
      <dl className={answersClass}>
        {replies.map((reply, index) => (
          <div className="grid min-w-0 gap-0.5" key={index}>
            <dt className={answerLabelClass}>{reply.question}</dt>
            <dd className={answerValueClass}>{reply.answer}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
