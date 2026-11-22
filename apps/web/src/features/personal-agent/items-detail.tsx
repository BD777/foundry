import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Bot,
  ChevronLeft,
  ExternalLink,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import type {
  PersonalAgentItem,
  PersonalAgentItemDetail,
  PersonalAgentItemEvent,
  PersonalAgentItemPlan,
  PersonalAgentItemPlanChoice,
  PersonalAgentItemStatus,
  PersonalAgentOperation,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { capturePersonalAgentInbox } from "../../api";
import { MarkdownContent } from "../../components/conversation/markdown-content";
import { Alert } from "../../components/ui/alert";
import { ClampedText } from "../../components/ui/clamped-text";
import { Button } from "../../components/ui/button";
import {
  ContextLinkRow,
  ContextList,
  ContextRowCopy,
} from "../../components/ui/context-card";
import { TextInput } from "../../components/ui/field";
import { RowMenu } from "../../components/ui/row-menu";
import { Subheading } from "../../components/ui/subheading";
import { serverErrorText } from "../../lib/errors";
import { chatHref } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { ItemPlan } from "./person-list-plan";
import { ItemHome } from "./items-home";
import { ItemNeedsYou } from "./items-needs-you";
import {
  helperStatusLabel,
  itemStatusLabel,
  originLabel,
  ownerLabel,
  stateLabel,
  workspaceLabel,
} from "./items-marks";
import { shortWhen } from "./items-model";
import { personalItemActions } from "./use-personal-items";

export interface ItemDetailProps {
  assistantId?: string;
  detail?: PersonalAgentItemDetail;
  error: string;
  /** The open items, for a plan's dependencies. */
  items: PersonalAgentItem[];
  operations: PersonalAgentOperation[];
  workspaces: WorkspaceProjection[];
  onBack: () => void;
  /** Back to the assistant's conversation, after asking it to continue. */
  onOpenAssistant: () => void;
  /** After a change: the lists and this item read again. */
  onChanged: () => Promise<void>;
  /** After the person deleted it: the selection clears. */
  onDeleted: () => void;
}

/**
 * One item in full: its words, who has it, the status actions, where it
 * lives (its home, the workspaces it touches, the chat following it), where
 * it came from, its summary, the work on it, its plan (editable while open) and
 * its timeline, one line per event.
 */
export function ItemDetail({
  assistantId,
  detail,
  error,
  items,
  operations,
  workspaces,
  onBack,
  onOpenAssistant,
  onChanged,
  onDeleted,
}: ItemDetailProps) {
  const { t, i18n } = useTranslation("personalAgent");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!detail) {
    return (
      <div className="grid gap-3">
        <BackButton onBack={onBack} t={t} />
        {error ? (
          <Alert title={t("items.detail.loadFailed")} tone="error">
            {error}
          </Alert>
        ) : (
          <p className="text-sm text-ink-muted">{t("loading")}</p>
        )}
      </div>
    );
  }
  const { item, events } = detail;
  const open = item.status === "open";

  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setActionError("");
    try {
      await change();
      await onChanged();
      return true;
    } catch (reason) {
      setActionError(serverErrorText(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const setStatus = (status: PersonalAgentItemStatus) =>
    run(() => personalItemActions.setStatus(assistantId, item, status));
  const setArchived = (archived: boolean) =>
    run(() => personalItemActions.setArchived(assistantId, item, archived));
  const changeHome = (workspaceId: string) =>
    run(() => personalItemActions.setHome(assistantId, item, workspaceId));
  const changeOwner = () =>
    run(() =>
      personalItemActions.setOwner(
        assistantId,
        item,
        item.owner === "person" ? "assistant" : "person",
      ),
    );

  const startEditing = () => {
    setDraft(item.text);
    setEditing(true);
  };
  const saveText = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (
      text === item.text ||
      (await run(() => personalItemActions.setText(assistantId, item, text)))
    )
      setEditing(false);
  };

  // The plan's own save throws on failure, so the plan shows the error itself.
  const savePlan = async (
    target: PersonalAgentItem,
    plan: PersonalAgentItemPlan,
  ) => {
    await personalItemActions.setPlan(assistantId, target, choiceOf(plan));
    await onChanged();
  };

  // The same prompt the row sent before: the person asks, the assistant continues.
  const askToContinue = async () => {
    setPending(true);
    setActionError("");
    try {
      await capturePersonalAgentInbox(assistantId, {
        text: t("planning.continuePrompt", { id: item.id, text: item.text }),
        messageId: crypto.randomUUID(),
      });
      onOpenAssistant();
    } catch (reason) {
      setActionError(serverErrorText(reason));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setActionError("");
    try {
      await personalItemActions.remove(assistantId, item);
      onDeleted();
    } catch (reason) {
      setActionError(serverErrorText(reason));
    } finally {
      setPending(false);
    }
  };

  const origin = originLabel(item, t);
  const language = i18n.language;
  const ownerChange =
    item.owner === "person"
      ? t("items.detail.changeToAssistant")
      : t("items.detail.changeToMe");
  return (
    <article
      aria-labelledby="fdy-items-detail-title"
      className="grid content-start gap-5"
    >
      <BackButton onBack={onBack} t={t} />
      <header className="grid gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          {editing ? (
            <form className="flex min-w-0 flex-1 gap-2" onSubmit={saveText}>
              <TextInput
                aria-label={t("items.detail.title")}
                autoFocus
                className="min-w-0 flex-1"
                disabled={pending}
                onChange={(event) => setDraft(event.target.value)}
                tone="boxed"
                value={draft}
              />
              <Button disabled={pending} size="sm" type="submit">
                {pending ? t("items.detail.saving") : t("items.detail.save")}
              </Button>
              <Button
                disabled={pending}
                onClick={() => setEditing(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("items.detail.cancel")}
              </Button>
            </form>
          ) : (
            <>
              <h2
                className="min-w-0 flex-1 text-xl leading-tight font-semibold wrap-anywhere text-ink"
                id="fdy-items-detail-title"
              >
                {item.text}
              </h2>
              <Button onClick={startEditing} size="sm" variant="secondary">
                {t("items.detail.edit")}
              </Button>
              <RowMenu
                items={[
                  ...(open
                    ? [
                        {
                          key: "continue",
                          label: t("items.detail.askContinue"),
                          icon: <Sparkles aria-hidden="true" size={15} />,
                          onSelect: () => void askToContinue(),
                        },
                      ]
                    : []),
                  {
                    key: "owner",
                    label: ownerChange,
                    icon:
                      item.owner === "person" ? (
                        <Bot aria-hidden="true" size={15} />
                      ) : (
                        <User aria-hidden="true" size={15} />
                      ),
                    onSelect: () => void changeOwner(),
                  },
                  {
                    key: "delete",
                    label: t("items.detail.delete"),
                    icon: <Trash2 aria-hidden="true" size={15} />,
                    tone: "danger" as const,
                    confirm: {
                      title: t("items.detail.deleteTitle", { text: item.text }),
                      body: t("items.detail.deleteBody"),
                      action: t("items.detail.deleteAction"),
                    },
                    onSelect: () => void remove(),
                  },
                ]}
                label={t("items.detail.moreFor", { text: item.text })}
              />
            </>
          )}
        </div>
        <p className="text-sm text-ink-muted">
          {[ownerLabel(item.owner, t), stateLabel(item, t), origin]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>
      {actionError ? (
        <Alert title={t("items.detail.actionFailed")} tone="error">
          {actionError}
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <StatusActions
          item={item}
          onArchive={() => void setArchived(true)}
          onRestore={() => void setArchived(false)}
          onStatus={(status) => void setStatus(status)}
          pending={pending}
        />
      </div>
      <ItemNeedsYou item={item} />
      <DetailSection title={t("items.home.title")}>
        <ItemHome
          item={item}
          onChangeHome={changeHome}
          pending={pending}
          workspaces={workspaces}
        />
      </DetailSection>
      {item.origin || item.quote ? (
        <DetailSection title={t("items.detail.origin")}>
          {origin ? <p className="text-sm text-ink-muted">{origin}</p> : null}
          {item.quote ? (
            <blockquote className="border-s border-line-soft ps-3 text-sm wrap-anywhere text-ink-muted">
              {item.quote}
            </blockquote>
          ) : null}
        </DetailSection>
      ) : null}
      <DetailSection title={t("items.detail.times")}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <TimeRow
            label={t("items.detail.created")}
            language={language}
            value={item.createdAt}
          />
          <TimeRow
            label={t("items.detail.updated")}
            language={language}
            value={item.updatedAt}
          />
          {item.closedAt ? (
            <TimeRow
              label={t("items.detail.closed")}
              language={language}
              value={item.closedAt}
            />
          ) : null}
          {item.archivedAt ? (
            <TimeRow
              label={t("items.detail.archived")}
              language={language}
              value={item.archivedAt}
            />
          ) : null}
        </dl>
      </DetailSection>
      <DetailSection title={t("items.detail.summary")}>
        {item.summary ? (
          <div className="text-sm text-ink">
            <MarkdownContent>{item.summary}</MarkdownContent>
          </div>
        ) : (
          <p className="text-sm text-ink-faint">
            {t("items.detail.noSummary")}
          </p>
        )}
      </DetailSection>
      <DetailSection title={t("items.detail.decisions")}>
        <ItemDecisions events={events} language={language} t={t} />
      </DetailSection>
      {item.plan ? (
        <DetailSection title={t("items.plan.title")}>
          <ItemPlan
            className="ps-0 justify-items-start"
            detailsOpen
            assistantId={assistantId}
            item={item}
            items={items}
            onRefresh={onChanged}
            onSave={open ? savePlan : undefined}
            operations={operations}
          />
        </DetailSection>
      ) : null}
      <DetailSection title={t("items.detail.work")}>
        {item.helpers.length ? (
          <ContextList className="list-none gap-1">
            {item.helpers.map((helper) => (
              <div key={helper.sessionId}>
                <ContextLinkRow
                  href={chatHref(helper.sessionId, helper.workspaceId)}
                  rel="noopener"
                  target="_blank"
                  title={helper.title}
                >
                  <ContextRowCopy
                    detail={[
                      helper.project,
                      helperStatusLabel(helper.status, t),
                      relativeWhen(helper.startedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    title={helper.title || t("items.helper.unnamed")}
                  />
                  <ExternalLink
                    aria-hidden="true"
                    className="flex-none text-ink-faint"
                    size={14}
                  />
                </ContextLinkRow>
              </div>
            ))}
          </ContextList>
        ) : (
          <p className="text-sm text-ink-faint">{t("items.detail.noWork")}</p>
        )}
      </DetailSection>
      <DetailSection title={t("items.detail.timeline")}>
        <ol className="grid gap-1.5 text-sm">
          {[...events]
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .map((event) => (
              <TimelineRow
                event={event}
                key={event.id}
                language={language}
                t={t}
                workspaces={workspaces}
              />
            ))}
        </ol>
      </DetailSection>
    </article>
  );
}

/**
 * The plan's draft as the person's choice: route and dependencies. The home
 * has its own control, so a plan save never moves the item.
 */
function choiceOf(plan: PersonalAgentItemPlan): PersonalAgentItemPlanChoice {
  return {
    route: plan.route?.kind,
    dependencies: plan.dependencies,
  };
}

function BackButton({
  onBack,
  t,
}: {
  onBack: () => void;
  t: TFunction<"personalAgent">;
}) {
  return (
    <Button
      className="justify-self-start sidebar:hidden"
      onClick={onBack}
      size="sm"
      variant="ghost"
    >
      <ChevronLeft aria-hidden="true" size={14} />
      {t("items.detail.back")}
    </Button>
  );
}

function StatusActions({
  item,
  onArchive,
  onRestore,
  onStatus,
  pending,
}: {
  item: PersonalAgentItem;
  onArchive: () => void;
  onRestore: () => void;
  onStatus: (status: PersonalAgentItemStatus) => void;
  pending: boolean;
}) {
  const { t } = useTranslation("personalAgent");
  if (item.archivedAt)
    return (
      <Button
        disabled={pending}
        onClick={onRestore}
        size="sm"
        variant="secondary"
      >
        {t("items.detail.restore")}
      </Button>
    );
  if (item.status === "open")
    return (
      <>
        <Button disabled={pending} onClick={() => onStatus("done")} size="sm">
          {t("items.detail.complete")}
        </Button>
        <Button
          disabled={pending}
          onClick={() => onStatus("dropped")}
          size="sm"
          variant="secondary"
        >
          {t("items.detail.drop")}
        </Button>
      </>
    );
  return (
    <>
      <Button
        disabled={pending}
        onClick={() => onStatus("open")}
        size="sm"
        variant="secondary"
      >
        {t("items.detail.reopen")}
      </Button>
      <Button
        disabled={pending}
        onClick={onArchive}
        size="sm"
        variant="secondary"
      >
        {t("items.detail.archive")}
      </Button>
    </>
  );
}

function DetailSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-2">
      <Subheading size="group">{title}</Subheading>
      {children}
    </section>
  );
}

/** A time as the short date and clock, relative to now; the full time on hover. */
function TimeRow({
  label,
  language,
  value,
}: {
  label: string;
  language: string;
  value: string;
}) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">
        <time dateTime={value} title={fullWhen(value)}>
          {shortWhen(value, language)}
        </time>
        <span className="ms-2 text-ink-faint">{relativeWhen(value)}</span>
      </dd>
    </>
  );
}

/** One event on one line: when · who · what. */
/**
 * The person's decisions on the item, oldest first, each with their own words;
 * one a later decision superseded is struck through.
 */
function ItemDecisions({
  events,
  language,
  t,
}: {
  events: PersonalAgentItemEvent[];
  language: string;
  t: TFunction<"personalAgent">;
}) {
  const decided = events
    .filter((event) => event.kind === "decided" && event.detail?.decision)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!decided.length) {
    return (
      <p className="text-sm text-ink-faint">{t("items.detail.noDecisions")}</p>
    );
  }
  const superseded = new Set(
    decided.map((event) => event.detail?.supersedes).filter(Boolean),
  );
  return (
    <ol className="grid gap-2.5 text-sm">
      {decided.map((event) => {
        const replaced = superseded.has(event.id);
        return (
          <li
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2"
            key={event.id}
          >
            <time
              className="pt-0.5 text-xs text-ink-faint tabular-nums"
              dateTime={event.at}
              title={fullWhen(event.at)}
            >
              {shortWhen(event.at, language)}
            </time>
            <div className="grid min-w-0 gap-0.5">
              <ClampedText
                className={
                  replaced ? "text-ink-faint line-through" : "text-ink"
                }
                clamp={3}
              >
                {event.detail?.decision ?? ""}
              </ClampedText>
              {replaced ? (
                <span className="text-xs text-ink-faint">
                  {t("items.detail.decisionSuperseded")}
                </span>
              ) : null}
              {event.detail?.quote ? (
                <ClampedText className="text-xs text-ink-muted" clamp={2}>
                  {t("items.detail.decisionQuote", {
                    quote: event.detail.quote,
                  })}
                </ClampedText>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TimelineRow({
  event,
  language,
  t,
  workspaces,
}: {
  event: PersonalAgentItemEvent;
  language: string;
  t: TFunction<"personalAgent">;
  workspaces: WorkspaceProjection[];
}) {
  const detail = event.detail ?? {};
  const actor: Record<PersonalAgentItemEvent["actor"], string> = {
    person: t("items.actor.person"),
    assistant: t("items.actor.assistant"),
    foundry: t("items.actor.foundry"),
    session: t("items.actor.session"),
  };
  const owner = (value?: string) =>
    value === "person"
      ? t("items.card.you")
      : value === "assistant"
        ? t("items.owner.assistant")
        : (value ?? "");
  const title = detail.title || t("items.helper.unnamed");
  let line: string;
  switch (event.kind) {
    case "created":
      line = t("items.event.created");
      break;
    case "edited":
      line = t("items.event.edited");
      break;
    case "owner_changed":
      line = t("items.event.ownerChanged", {
        from: owner(detail.from),
        to: owner(detail.to),
      });
      break;
    case "status_changed":
      line = t("items.event.statusChanged", {
        from: itemStatusLabel(detail.from, t),
        to: itemStatusLabel(detail.to, t),
      });
      break;
    case "summary_updated":
      line = t("items.event.summaryUpdated");
      break;
    case "helper_started":
      line = t("items.event.helperStarted", { title });
      break;
    case "helper_ended":
      line = t("items.event.helperEnded", {
        title,
        status: helperStatusLabel(detail.to ?? "done", t),
      });
      break;
    case "needs_you_opened":
      line = detail.title
        ? t("items.event.needsYouOpenedFor", { what: detail.title })
        : t("items.event.needsYouOpened");
      break;
    case "needs_you_answered":
      line = detail.quote
        ? t("items.event.needsYouAnsweredWith", { words: detail.quote })
        : t("items.event.needsYouAnswered");
      break;
    case "archived":
      line = t("items.event.archived");
      break;
    case "restored":
      line = t("items.event.restored");
      break;
    case "claimed":
      line = detail.from
        ? t("items.event.claimedReplaced")
        : t("items.event.claimed");
      break;
    case "released":
      line = t("items.event.released");
      break;
    case "decided":
      line = t("items.event.decided", { decision: detail.decision ?? "" });
      break;
    case "rehomed":
      line = t("items.event.rehomed", {
        from: workspaceLabel(detail.from, workspaces, t),
        to: workspaceLabel(detail.to, workspaces, t),
      });
      break;
  }
  return (
    <li className="flex min-w-0 items-baseline gap-2">
      <time
        className="flex-none text-xs text-ink-faint tabular-nums"
        dateTime={event.at}
        title={fullWhen(event.at)}
      >
        {shortWhen(event.at, language)}
      </time>
      <span className="flex-none text-xs text-ink-muted">
        {actor[event.actor]}
      </span>
      <ClampedText className="min-w-0 flex-1" clamp={2} tone="ink">
        {line}
      </ClampedText>
    </li>
  );
}
