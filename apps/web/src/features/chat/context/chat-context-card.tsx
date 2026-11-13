import { ChatAccountUsage } from "./chat-account-usage";
import type { AccountUsageTarget } from "./chat-account-usage-model";
import {
  ChevronRight,
  ExternalLink,
  FolderClosed,
  GitBranch,
  X,
} from "lucide-react";
import { memo } from "react";
import {
  FrameThumbnail,
  frameTime,
} from "../../../components/conversation/frame-thumbnail";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button";
import {
  ContextGroup,
  ContextHeading,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextRowIcon,
  ContextCard,
  ContextSection,
  ContextStaticRow,
} from "../../../components/ui/context-card";
import { ChatSessionStatusLine } from "./chat-session-status";
import { BackgroundSection } from "./chat-context-background";
import { SessionFileSections } from "./chat-context-files";
import { useFoldOpen } from "./chat-context-folds";
import { SubagentSection } from "./chat-context-subagents";
import { TimerRow } from "./chat-context-timers";
import { GoalSection } from "./chat-context-goal";
import { hasSessionWork, SessionWorkSection } from "./chat-context-work";
import type { SessionWorkController } from "./use-session-work";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
  ChatScreenItem,
} from "../chat-types";

export { backgroundRowDetail } from "./chat-context-background";

function ResourceRow({
  item,
  kind,
  onSelect,
  selected,
}: {
  item: ChatContextResourceItem;
  kind: "preview" | "source";
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  return (
    <ContextRow
      aria-pressed={selected}
      onClick={() => onSelect?.(item)}
      selected={selected}
      title={item.detail ?? item.label}
    >
      <ContextRowIcon kind={kind === "preview" ? "preview" : "muted"}>
        {item.kind === "web" ? (
          <ExternalLink size={16} />
        ) : (
          <FolderClosed size={16} />
        )}
      </ContextRowIcon>
      <ContextRowCopy
        detail={
          item.detail && item.detail !== item.label ? item.detail : undefined
        }
        title={item.label}
      />
    </ContextRow>
  );
}

/** The newest tool screenshot: a row opening the screen (DEV-075). */
function ScreenSection({
  item,
  onSelect,
  selected,
}: {
  item: ChatScreenItem;
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  const { t, i18n } = useTranslation(["chat", "conversation"]);
  const caption = t("chat:contextCard.screenLatest", {
    source: item.label,
    time: frameTime(item.latest, i18n.language),
  });
  const open = () => onSelect?.({ ...item, frameId: undefined });
  return (
    <ContextSection>
      <ContextHeading>{t("chat:contextCard.screen")}</ContextHeading>
      <ContextList>
        <ContextRow
          aria-pressed={selected}
          className="min-h-[62px]"
          onClick={open}
          selected={selected}
        >
          <FrameThumbnail frame={item.latest} label={caption} size="row" />
          <ContextRowCopy
            detail={caption}
            title={t("conversation:process.viewScreen")}
          />
          <ChevronRight
            aria-hidden="true"
            className="flex-none text-ink-faint"
            size={15}
          />
        </ContextRow>
      </ContextList>
    </ContextSection>
  );
}

/** The session that started the chat: a row opening it, when it may be opened. */
function StartedBySection({
  link,
}: {
  link: NonNullable<ChatContextCardData["startedBy"]>;
}) {
  const { t } = useTranslation("chat");
  const content = (
    <>
      <ContextRowIcon>
        <GitBranch size={16} />
      </ContextRowIcon>
      <ContextRowCopy title={link.label} />
    </>
  );
  return (
    <ContextSection>
      <ContextHeading>{t("contextCard.startedBy")}</ContextHeading>
      <ContextList>
        {link.onOpen ? (
          <ContextRow
            onClick={link.onOpen}
            title={t("contextCard.openStartedBy", { title: link.label })}
          >
            {content}
            <ChevronRight
              aria-hidden="true"
              className="flex-none text-ink-faint"
              size={14}
            />
          </ContextRow>
        ) : (
          <ContextStaticRow>{content}</ContextStaticRow>
        )}
      </ContextList>
    </ContextSection>
  );
}

export const ChatContextCard = memo(function ChatContextCard({
  accountUsage,
  usageCompletion,
  work,
  canControl = false,
  chatKey,
  data,
  onClearTurnFilter,
  onClose,
  onRetrySubagents,
  onSelect,
  reveal,
  selectedId,
  turnFilter,
}: {
  accountUsage?: AccountUsageTarget;
  usageCompletion?: string;
  work?: SessionWorkController;
  canControl?: boolean;
  /** The open chat: which sections it unfolded is remembered by this key. */
  chatKey?: string;
  data: ChatContextCardData;
  onClearTurnFilter?: () => void;
  onClose?: () => void;
  /** Refreshing the subagents failed; offered as a retry beside them. */
  onRetrySubagents?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  /** Rows to open and focus: files an answer names, or running work. */
  reveal?: { ids: string[] };
  selectedId?: string;
  /** Shows only the files one turn (input) wrote or named. */
  turnFilter?: string;
}) {
  const { t } = useTranslation("chat");
  const [statusOpen, setStatusOpen] = useFoldOpen(
    chatKey && `${chatKey}:status`,
  );
  // What is running (work, subagents, background commands) reads apart from
  // what the chat produced or opened (files, screen, previews, sources).
  const showWork =
    work !== undefined &&
    Boolean(work.list || work.error) &&
    hasSessionWork(work);
  const showTimers = !work?.list && data.timers.length > 0;
  const showSubagents = !work?.list && data.subagents.length > 0;
  const hasActivity =
    Boolean(data.goal) ||
    showWork ||
    showTimers ||
    showSubagents ||
    data.background.length > 0;
  return (
    <ContextCard
      className="max-[1360px]:max-h-full max-[1360px]:overflow-y-auto max-[1360px]:[&>section:first-of-type]:pr-13.5"
      aria-label={t("contextCard.label")}
    >
      {onClose ? (
        <Button
          aria-label={t("contextCard.hide")}
          className="hidden max-[1360px]:absolute max-[1360px]:top-3 max-[1360px]:right-3 max-[1360px]:z-1 max-[1360px]:inline-flex max-[1360px]:size-7 max-[1360px]:bg-control-ghost-hover max-[1360px]:text-ink-muted"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X size={16} />
        </Button>
      ) : null}

      {data.status ? (
        <ChatSessionStatusLine
          onOpenChange={setStatusOpen}
          open={statusOpen}
          status={data.status}
        />
      ) : null}

      {accountUsage ? (
        <ChatAccountUsage target={accountUsage} completion={usageCompletion} />
      ) : null}

      {data.startedBy ? <StartedBySection link={data.startedBy} /> : null}

      {hasActivity ? (
        <ContextGroup kind="activity" label={t("contextCard.groups.activity")}>
          {data.goal ? (
            <GoalSection canControl={canControl} goal={data.goal} />
          ) : null}

          {showWork ? (
            <SessionWorkSection
              controller={work}
              canControl={canControl}
              onInspect={(item) => {
                const source = [...data.subagents, ...data.timers].find(
                  (row) =>
                    row.sessionId === item.sessionId &&
                    (row.kind === "subagent" ? row.taskId : row.task.id) ===
                      item.sourceId,
                );
                return source && onSelect ? () => onSelect(source) : undefined;
              }}
              reveal={reveal}
            />
          ) : null}

          {showTimers ? (
            <ContextSection>
              <ContextHeading>{t("work.title")}</ContextHeading>
              <ContextList>
                {data.timers.map((item) => (
                  <TimerRow
                    item={item}
                    key={item.id}
                    onSelect={onSelect}
                    selected={selectedId === item.id}
                  />
                ))}
              </ContextList>
            </ContextSection>
          ) : null}

          {showSubagents ? (
            <SubagentSection
              chatKey={chatKey}
              items={data.subagents}
              onRetry={onRetrySubagents}
              onSelect={onSelect}
              reveal={reveal}
              selectedId={selectedId}
            />
          ) : null}

          {data.background.length > 0 ? (
            <BackgroundSection
              chatKey={chatKey}
              items={data.background}
              onSelect={onSelect}
              reveal={reveal}
              selectedId={selectedId}
            />
          ) : null}
        </ContextGroup>
      ) : null}

      <ContextGroup kind="materials" label={t("contextCard.groups.materials")}>
        <SessionFileSections
          data={data}
          onClearTurnFilter={onClearTurnFilter}
          onSelect={onSelect}
          reveal={reveal}
          turnFilter={turnFilter}
        />

        {data.screen ? (
          <ScreenSection
            item={data.screen}
            onSelect={onSelect}
            selected={selectedId === data.screen.id}
          />
        ) : null}

        {data.previews.length > 0 ? (
          <ContextSection>
            <ContextHeading>{t("contextCard.previews")}</ContextHeading>
            <ContextList>
              {data.previews.map((item) => (
                <ResourceRow
                  item={item}
                  key={item.id}
                  kind="preview"
                  onSelect={onSelect}
                  selected={selectedId === item.id}
                />
              ))}
            </ContextList>
          </ContextSection>
        ) : null}

        {data.sources.length > 0 ? (
          <ContextSection>
            <ContextHeading>{t("contextCard.sources")}</ContextHeading>
            <ContextList>
              {data.sources.map((item) => (
                <ResourceRow
                  item={item}
                  key={item.id}
                  kind="source"
                  onSelect={onSelect}
                  selected={selectedId === item.id}
                />
              ))}
            </ContextList>
          </ContextSection>
        ) : null}
      </ContextGroup>
    </ContextCard>
  );
});
