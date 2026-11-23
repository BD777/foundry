import {
  AlarmClock,
  CircleCheck,
  FileText,
  Info,
  MessagesSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentBackgroundTaskOutput } from "@bd777/foundry-protocol";
import { CodeBlockCopyButton } from "streamdown";
import { isAbortError, readBackgroundTaskOutput } from "../../api";
import { cn } from "../../lib/cn";
import { chatHref } from "../../lib/in-app-navigation";
import { clockTime, fullWhen } from "../../lib/time-format";
import { AppLink } from "../ui/app-link";
import { Button } from "../ui/button";
import { CodeBlock, codeBlockActionClass } from "../ui/code-block";
import { LoadingState } from "../ui/loading";
import { AnnotatedText } from "./annotation-reference";
import { MarkdownContent } from "./markdown-content";
import { sourceBody, type TurnSource } from "./turn-source";
import type {
  ChatMessageItem,
  ConversationBackgroundTask,
} from "./conversation-types";
import { MetaLine } from "../ui/meta-line";

const sourceIcons: Partial<Record<TurnSource["kind"], LucideIcon>> = {
  session: MessagesSquare,
  report: FileText,
  background: CircleCheck,
  scheduled: AlarmClock,
  notice: Info,
  automatic: Zap,
};

/** About six lines of the row's text-sm/1.45 body: 14px × 1.45 × 6. */
const LONG_BODY_LINES = 6;
/** As much of a task's log as its source row shows: its end. */
const OUTPUT_TAIL_CHARS = 2 * 1024;

function isLongBody(text: string): boolean {
  return (
    text.split(/\r?\n/).length > LONG_BODY_LINES ||
    // Wrapping means a single long paragraph can exceed six lines too.
    text.length > LONG_BODY_LINES * 70
  );
}

/** A child report's status in words; an unknown status stays as it came. */
function reportStatus(
  status: string | undefined,
  t: ReturnType<typeof useTranslation<"conversation">>["t"],
): string | undefined {
  switch (status) {
    case "completed":
      return t("turnSource.status.completed");
    case "failed":
      return t("turnSource.status.failed");
    case "canceled":
      return t("turnSource.status.canceled");
    default:
      return status;
  }
}

/** How a finished background task ended, in words. */
function taskOutcome(
  task: ConversationBackgroundTask,
  t: ReturnType<typeof useTranslation<"conversation">>["t"],
): string | undefined {
  const parts: string[] = [];
  if (task.status === "failed") parts.push(t("turnSource.status.failed"));
  if (task.status === "stopped") parts.push(t("turnSource.status.stopped"));
  if (task.status === "ended") parts.push(t("turnSource.status.ended"));
  if (task.exitCode !== undefined)
    parts.push(t("turnSource.exitCode", { code: task.exitCode }));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A task's description, short enough for the title line; an id is no name. */
function taskDescription(task: ConversationBackgroundTask): string | undefined {
  const text = task.description.trim();
  if (!text || text === task.id) return undefined;
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

function SourceLabel({
  source,
  title,
}: {
  source: TurnSource;
  title?: string;
}) {
  const { t } = useTranslation("conversation");
  const status = reportStatus(source.status, t);
  switch (source.kind) {
    case "session":
      return (
        <>
          <span>{t("turnSource.fromSession")}</span>{" "}
          <SourceSessionLink source={source} title={title} />
        </>
      );
    case "report":
      return (
        <MetaLine as="span" separatorClassName="font-normal">
          <span>
            <SourceSessionLink source={source} title={title} />{" "}
            <span>{t("turnSource.reported")}</span>
          </span>
          {status ? (
            <span className="font-normal text-ink-muted">{status}</span>
          ) : null}
        </MetaLine>
      );
    case "background":
      return <BackgroundLabel source={source} />;
    case "scheduled":
      return (
        <span>
          {title
            ? t("turnSource.scheduledWith", { title })
            : t("turnSource.scheduled")}
        </span>
      );
    case "notice":
      return (
        <span>
          {source.relay
            ? title
              ? t(`turnSource.relay.${source.relay}With`, { title })
              : t(`turnSource.relay.${source.relay}`)
            : t("turnSource.notice")}
        </span>
      );
    case "automatic":
      return (
        <span>
          {source.raw
            ? t("turnSource.automaticWith", { kind: source.raw })
            : t("turnSource.automatic")}
        </span>
      );
    case "channel":
      return null;
  }
}

/**
 * A background turn's title: the work's kind and description, then how it
 * ended. The command itself stays under the row's expansion (DEV-249).
 */
function BackgroundLabel({ source }: { source: TurnSource }) {
  const { t } = useTranslation("conversation");
  const tasks = source.tasks ?? [];
  if (tasks.length === 1) {
    const task = tasks[0]!;
    const description = taskDescription(task);
    const outcome = taskOutcome(task, t);
    return (
      <MetaLine as="span" separatorClassName="font-normal text-ink-faint">
        <span>{t("turnSource.background")}</span>
        <span className="font-normal text-ink-muted">
          {t(`turnSource.taskKind.${task.kind}`)}
        </span>
        {description ? (
          <span className="min-w-0 font-normal text-ink-muted [overflow-wrap:anywhere]">
            {description}
          </span>
        ) : null}
        {outcome ? (
          <span className="font-normal text-ink-muted">{outcome}</span>
        ) : null}
      </MetaLine>
    );
  }
  if (tasks.length > 1)
    return (
      <span>{t("turnSource.backgroundMany", { count: tasks.length })}</span>
    );
  return <span>{t("turnSource.background")}</span>;
}

function SourceSessionLink({
  source,
  title,
}: {
  source: TurnSource;
  title?: string;
}) {
  const { t } = useTranslation("conversation");
  if (!title) return null;
  if (source.onOpen)
    return (
      <Button
        onClick={source.onOpen}
        size="inline"
        title={t("message.openSender", { title })}
        variant="link"
      >
        {title}
      </Button>
    );
  if (!source.sessionId)
    return <strong className="font-medium text-ink">{title}</strong>;
  return (
    <Button asChild size="inline" variant="link">
      <AppLink
        href={chatHref(source.sessionId)}
        title={t("message.openSender", { title })}
      >
        {title}
      </AppLink>
    </Button>
  );
}

function SourceBody({
  markdown = false,
  text,
}: {
  /** A report or another session's message: render its Markdown. */
  markdown?: boolean;
  text: string;
}) {
  const { t } = useTranslation("conversation");
  const [open, setOpen] = useState(false);
  const long = isLongBody(text);
  return (
    <div className="grid min-w-0 justify-items-start gap-1">
      {markdown ? (
        <div
          className={cn(
            "min-w-0 text-sm text-ink-muted [overflow-wrap:anywhere]",
            long && !open && "max-h-[122px] overflow-hidden",
          )}
        >
          <MarkdownContent compact>{text}</MarkdownContent>
        </div>
      ) : (
        <div
          className={cn(
            "min-w-0 text-sm leading-[1.45] whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]",
            long && !open && "max-h-[122px] overflow-hidden",
          )}
        >
          <AnnotatedText text={text} />
        </div>
      )}
      {long ? (
        <Button
          aria-expanded={open}
          className="font-semibold text-ink-muted"
          onClick={() => setOpen((value) => !value)}
          size="inline"
          variant="link"
        >
          {t(open ? "turnSource.hideBody" : "turnSource.showBody")}
        </Button>
      ) : null}
    </div>
  );
}

/** A task's command as the app's code block, with the copy control. */
function TaskCode({
  code,
  language,
}: {
  code: string;
  language: "bash" | "text";
}) {
  const { t } = useTranslation("conversation");
  return (
    <CodeBlock
      actions={
        <CodeBlockCopyButton
          className={codeBlockActionClass}
          code={code}
          title={t("diagram.controls.copyCode")}
        />
      }
      code={code}
      language={language}
    />
  );
}

/** A finished background task's command and output, read as a member. */
function BackgroundTaskDetails({ task }: { task: ConversationBackgroundTask }) {
  const { t } = useTranslation("conversation");
  const [state, setState] = useState<{
    loading: boolean;
    output?: AgentBackgroundTaskOutput;
    membersOnly?: boolean;
    error?: string;
  }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ loading: true });
    readBackgroundTaskOutput(task.sessionId, task.id, {
      signal: controller.signal,
    })
      .then((output) => {
        if (!cancelled) setState({ loading: false, output });
      })
      .catch((reason) => {
        if (cancelled || isAbortError(reason)) return;
        const status = (reason as { status?: number }).status;
        if (status === 403) {
          setState({ loading: false, membersOnly: true });
          return;
        }
        setState({
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [task.sessionId, task.id]);

  if (state.loading)
    return <LoadingState label={t("turnSource.loadingDetails")} />;
  if (state.membersOnly)
    return (
      <p className="text-xs leading-[1.45] text-ink-muted">
        {t("turnSource.detailsMembersOnly")}
      </p>
    );
  if (state.error)
    return (
      <p className="text-xs leading-[1.45] text-ink-muted">
        {t("turnSource.detailsFailed", { error: state.error })}
      </p>
    );
  const output = state.output;
  const command = output?.command?.trim();
  const content =
    output?.kind === "text" ? output.content.replace(/^\n+/, "") : "";
  const tailCut = content.length > OUTPUT_TAIL_CHARS;
  // A cut log starts at the next whole line, so its first row reads.
  const tailStart = tailCut ? content.length - OUTPUT_TAIL_CHARS : 0;
  const nextLine = tailCut ? content.indexOf("\n", tailStart) + 1 : 0;
  const tail = tailCut
    ? content.slice(nextLine > tailStart ? nextLine : tailStart)
    : content;
  if (!command && !tail)
    return (
      <p className="text-xs leading-[1.45] text-ink-muted">
        {output?.kind === "binary"
          ? t("turnSource.outputBinary")
          : t("turnSource.outputMissing")}
      </p>
    );
  return (
    <div className="grid min-w-0 gap-2">
      {command ? (
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-[650] text-ink-muted">
            {t("turnSource.command")}
          </p>
          <TaskCode code={command} language="bash" />
        </div>
      ) : null}
      {tail ? (
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-[650] text-ink-muted">
            {t("turnSource.output")}
          </p>
          <TaskCode code={tail} language="text" />
          {tailCut ? (
            <p className="text-xs leading-[1.45] text-ink-faint">
              {t("turnSource.outputTail", {
                size: OUTPUT_TAIL_CHARS / 1024,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What a background or timer row shows under its expansion. */
function SourceDetails({ source }: { source: TurnSource }) {
  const { t } = useTranslation("conversation");
  return (
    <div className="grid min-w-0 gap-3 pt-1">
      {source.tasks?.length ? (
        source.tasks.map((task) => {
          const outcome = taskOutcome(task, t);
          return (
            <div className="grid min-w-0 gap-1.5" key={task.id}>
              {source.tasks!.length > 1 ? (
                <p className="text-xs leading-[1.45] font-[650] text-ink-muted">
                  {taskDescription(task) ??
                    t(`turnSource.taskKind.${task.kind}`)}
                  {outcome ? (
                    <span className="font-normal"> · {outcome}</span>
                  ) : null}
                </p>
              ) : null}
              <BackgroundTaskDetails task={task} />
            </div>
          );
        })
      ) : source.detail ? (
        <div className="max-h-[min(50vh,420px)] min-w-0 overflow-y-auto text-sm leading-[1.45] whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]">
          {source.detail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A turn the person did not start: who or what started it, when, and — for
 * a message another session sent — what it said, quiet and compact, never
 * in the person's bubble. The answer after it renders as usual.
 */
export function TurnSourceRow({
  message,
  source,
}: {
  message: ChatMessageItem;
  source: TurnSource;
}) {
  const { t } = useTranslation("conversation");
  const Icon = sourceIcons[source.kind];
  const title = source.title;
  const body = message.kind === "boundary" ? message.text : sourceBody(message);
  const text = typeof body === "string" ? body.trim() : "";
  // A continuation's own line ("Claude continued…") is the title's business;
  // its prompt or summary is the detail under the expansion (DEV-249).
  const continuation =
    source.kind === "background" || source.kind === "scheduled";
  // A helper's report, another session's message or a Foundry notice arrives
  // as Markdown; the person's words (also relayed by a notice) and a
  // channel's text keep their own rendering.
  const markdownBody =
    source.kind === "report" ||
    source.kind === "session" ||
    (source.kind === "notice" && !source.relay);
  const detailText = source.detail?.trim();
  const hasDetails = Boolean(source.tasks?.length || detailText);
  const [open, setOpen] = useState(false);
  const when = message.at ? new Date(message.at) : undefined;
  const validWhen = when && !Number.isNaN(when.getTime()) ? when : undefined;
  return (
    <section
      className="fdy-chat-turn-source flex min-w-0 items-start gap-2.5 rounded-lg bg-panel-soft px-3 py-2 text-sm"
      data-source={source.kind}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="mt-0.5 flex-none text-ink-faint"
          size={15}
        />
      ) : null}
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-normal text-ink-muted">
          <span className="font-[650]">
            <SourceLabel source={source} title={title} />
          </span>
          {validWhen ? (
            <time
              className="flex-none text-ink-faint tabular-nums"
              dateTime={message.at}
              title={fullWhen(message.at)}
            >
              {clockTime(validWhen, { date: "2-digit", hour12: false })}
            </time>
          ) : null}
        </div>
        {!continuation && text ? (
          <SourceBody markdown={markdownBody} text={text} />
        ) : null}
        {source.caughtUp && text ? <SourceBody text={text} /> : null}
        {hasDetails ? (
          <Button
            aria-expanded={open}
            className="justify-self-start font-semibold text-ink-muted"
            onClick={() => setOpen((value) => !value)}
            size="inline"
            variant="link"
          >
            {t(open ? "turnSource.hideDetails" : "turnSource.showDetails")}
          </Button>
        ) : null}
        {open && hasDetails ? <SourceDetails source={source} /> : null}
      </div>
    </section>
  );
}
