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
import { Checkbox, FieldHint, Radio, TextInput } from "../ui/field";
import { agentQuestionReplyText } from "./agent-questions";
import { MarkdownContent } from "./markdown-content";
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
/** What choosing an option means, under its text. */
const optionDetailClass = "text-xs leading-[1.4] font-normal text-ink-muted";

/**
 * A question's text as the Agent wrote it: its line breaks kept, its links
 * (an authorization page, a document) open in a new tab.
 */
function QuestionText({ children }: { children: string }) {
  return <MarkdownContent typedText>{children}</MarkdownContent>;
}

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
 * The questions an Agent asked (Codex async questions, which do not wait;
 * Claude's AskUserQuestion, which holds its turn for a while; a child
 * session's, which wait for its next message) or an approval it asks for
 * (the plan, approve or deny): choices, the person's own answer, and where
 * they stand. Open while the Agent waits; otherwise collapsed to "Answer",
 * which reopens it.
 */
export function AgentQuestionCard({
  active,
  answers,
  itemId,
  onAnswer,
  questions,
  relayed = false,
  state,
}: {
  /** A turn runs: the answer goes into it, not into the next one. */
  active: boolean;
  answers?: string[];
  itemId: string;
  /** Sends the reply text once per `key`; why it failed, if it did. */
  onAnswer?: (text: string, key: string) => Promise<string | undefined>;
  questions: AgentQuestion[];
  /** Also asked of the session that started this one. */
  relayed?: boolean;
  state: ConversationQuestionState;
}) {
  const { t } = useTranslation("conversation");
  const approval = questions.some((question) => question.approval);
  // An approval's choices are canonical ("Approve", "Deny"): the answer
  // keeps them, the card shows them in the reader's language.
  const choiceLabel = (question: AgentQuestion, option: string) =>
    !question.approval
      ? option
      : option === "Approve"
        ? t("question.approve")
        : option === "Deny"
          ? t("question.deny")
          : option;
  const questionTitle = (question: AgentQuestion) =>
    question.approval && question.title === "Approve this plan?"
      ? t("question.approvalPlan")
      : question.title;
  const groupId = useId();
  const [open, setOpen] = useState(state === "waiting");
  const [choices, setChoices] = useState<string[]>(() =>
    questions.map((question) =>
      !question.options?.length ? other : question.multiSelect ? "" : "0",
    ),
  );
  // The options chosen of a question that takes several.
  const [picked, setPicked] = useState<number[][]>(() =>
    questions.map(() => []),
  );
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<string[]>();
  const card = useRef<HTMLElement>(null);
  // The questions the person has been to: Enter sends only once each was.
  const visited = useRef(new Set<number>());
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
    const own = (texts[index] ?? "").trim();
    if (question.multiSelect && question.options?.length)
      return [
        ...question.options.filter((_, at) => picked[index]?.includes(at)),
        ...(choices[index] === other && own ? [own] : []),
      ].join(", ");
    const choice = choices[index];
    return choice === other || !question.options?.length
      ? own
      : (question.options[Number(choice)] ?? "");
  };
  const toggle = (index: number, at: number) =>
    setPicked((current) =>
      current.map((chosen, of) =>
        of !== index
          ? chosen
          : chosen.includes(at)
            ? chosen.filter((value) => value !== at)
            : [...chosen, at],
      ),
    );
  const toggleOther = (index: number) =>
    choose(index, choices[index] === other ? "" : other);
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
  /** Moves to a question: its chosen option, else its first control. */
  const focusQuestion = (index: number) => {
    const group = card.current?.querySelectorAll("fieldset")[index];
    (
      group?.querySelector<HTMLInputElement>("input:checked") ??
      group?.querySelector<HTMLInputElement>("input")
    )?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (target.dataset.question === undefined) return;
    const index = Number(target.dataset.question);
    // Enter answers one question at a time: it goes on to the next one, and
    // sends from the last once every question was seen. Never mid-IME.
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (index < questions.length - 1) {
        focusQuestion(index + 1);
        return;
      }
      const unseen = questions.findIndex((_, at) => !visited.current.has(at));
      if (unseen >= 0) focusQuestion(unseen);
      else void submit();
      return;
    }
    if (target.type !== "radio" && target.type !== "checkbox") return;
    // A digit picks (or, of several, toggles) that option of the question.
    const question = questions[index];
    const options = question?.options ?? [];
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      event.preventDefault();
      if (question?.multiSelect) toggle(index, digit - 1);
      else choose(index, String(digit - 1));
    }
  };
  return (
    <section
      aria-label={approval ? t("question.approvalTitle") : t("question.title")}
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
        <strong className="font-[650]">
          {approval ? t("question.approvalTitle") : t("question.title")}
        </strong>
        <Badge tone={stateTones[shown]}>{t(`question.state.${shown}`)}</Badge>
      </div>
      {given.length ? (
        <dl className={answersClass}>
          {questions.map((question, index) =>
            given[index] ? (
              <div className="grid min-w-0 gap-0.5" key={index}>
                <dt className={answerLabelClass}>
                  <QuestionText>{questionTitle(question)}</QuestionText>
                </dt>
                <dd className={answerValueClass}>
                  {choiceLabel(question, given[index])}
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : open ? (
        <form className="grid gap-3" onKeyDown={keys} onSubmit={submit}>
          {questions.map((question, index) => (
            <fieldset
              aria-labelledby={`${groupId}-${index}-title`}
              className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
              key={index}
              onFocus={() => visited.current.add(index)}
            >
              <div
                className="mb-1.5 grid gap-0.5 text-md leading-normal font-semibold text-ink"
                id={`${groupId}-${index}-title`}
              >
                {question.header ? (
                  <span className="text-2xs leading-[1.3] font-[550] text-ink-faint">
                    {question.header}
                  </span>
                ) : null}
                <QuestionText>{questionTitle(question)}</QuestionText>
              </div>
              {question.detail ? (
                <div className="max-h-80 overflow-auto rounded-md bg-inset px-3 py-2 text-sm">
                  <QuestionText>{question.detail}</QuestionText>
                </div>
              ) : null}
              {question.options?.length ? (
                <div className="grid gap-0.5">
                  {question.options.map((option, at) => (
                    <label className={optionClass} key={at}>
                      {question.multiSelect ? (
                        <Checkbox
                          className="flex-none"
                          checked={picked[index]?.includes(at) ?? false}
                          data-question={index}
                          name={`${groupId}-${index}`}
                          onChange={() => toggle(index, at)}
                          value={String(at)}
                        />
                      ) : (
                        <Radio
                          className="flex-none"
                          checked={choices[index] === String(at)}
                          data-question={index}
                          name={`${groupId}-${index}`}
                          onChange={() => choose(index, String(at))}
                          value={String(at)}
                        />
                      )}
                      <span className="grid min-w-0 gap-0.5 wrap-anywhere">
                        <span>{choiceLabel(question, option)}</span>
                        {question.descriptions?.[at] ? (
                          <span className={optionDetailClass}>
                            {question.descriptions[at]}
                          </span>
                        ) : null}
                      </span>
                      {at === 0 && !question.unranked ? (
                        <small className="ml-auto flex-none text-2xs font-[550] text-ink-faint">
                          {t("question.recommended")}
                        </small>
                      ) : null}
                    </label>
                  ))}
                  <label className={optionClass}>
                    {question.multiSelect ? (
                      <Checkbox
                        className="flex-none"
                        checked={choices[index] === other}
                        data-question={index}
                        name={`${groupId}-${index}`}
                        onChange={() => toggleOther(index)}
                        value={other}
                      />
                    ) : (
                      <Radio
                        className="flex-none"
                        checked={choices[index] === other}
                        data-question={index}
                        name={`${groupId}-${index}`}
                        onChange={() => choose(index, other)}
                        value={other}
                      />
                    )}
                    <span className="min-w-0 wrap-anywhere">
                      {question.approval
                        ? t("question.denyWithReason")
                        : t("question.other")}
                    </span>
                  </label>
                  {choices[index] === other ? (
                    <TextInput
                      aria-label={
                        question.approval
                          ? t("question.denyWithReason")
                          : t("question.other")
                      }
                      data-question={index}
                      className="mt-1 ml-[31px] w-[calc(100%-31px)]"
                      autoFocus
                      onChange={(event) => type(index, event.target.value)}
                      placeholder={
                        question.approval
                          ? t("question.denyPlaceholder")
                          : t("question.otherPlaceholder")
                      }
                      tone="boxed"
                      value={texts[index]}
                    />
                  ) : null}
                </div>
              ) : (
                <TextInput
                  aria-label={t("question.freeText")}
                  data-question={index}
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
              {relayed && state === "waiting"
                ? `${t("question.relayed")} `
                : null}
              {active ? t("question.intoTurn") : t("question.nextTurn")}{" "}
              {questions.length > 1
                ? t("question.shortcutsMany")
                : t("question.shortcuts")}
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
            {questions.map(questionTitle).join(" · ")}
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
            <dt className={answerLabelClass}>
              <QuestionText>{reply.question}</QuestionText>
            </dt>
            <dd className={answerValueClass}>{reply.answer}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
