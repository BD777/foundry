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
} from "../../components/conversation/frame-thumbnail";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ChatSessionStatusLine } from "./chat-session-status";
import { SessionFileSections } from "./chat-context-files";
import { useFoldOpen } from "./chat-context-folds";
import { SubagentSection } from "./chat-context-subagents";
import { TimerRow } from "./chat-context-timers";
import { SessionWorkSection } from "./chat-context-work";
import type { SessionWorkController } from "./use-session-work";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
  ChatScreenItem,
} from "./chat-types";

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
    <Button
      aria-pressed={selected}
      className="fdy-chat-context-row"
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect?.(item)}
      title={item.detail ?? item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind={kind}>
        {item.kind === "web" ? (
          <ExternalLink size={16} />
        ) : (
          <FolderClosed size={16} />
        )}
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        {item.detail && item.detail !== item.label ? (
          <em>{item.detail}</em>
        ) : null}
      </span>
    </Button>
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
    <section className="fdy-chat-context-section">
      <h3>{t("chat:contextCard.screen")}</h3>
      <div className="fdy-chat-context-list">
        <Button
          aria-pressed={selected}
          className="fdy-chat-context-row fdy-chat-context-screen"
          data-selected={selected ? "true" : "false"}
          onClick={open}
          variant="ghost"
        >
          <FrameThumbnail frame={item.latest} label={caption} size="row" />
          <span className="fdy-chat-context-row-copy">
            <strong>{t("conversation:process.viewScreen")}</strong>
            <em>{caption}</em>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="fdy-chat-context-row-forward"
            size={15}
          />
        </Button>
      </div>
    </section>
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
      <span className="fdy-chat-context-row-icon">
        <GitBranch size={16} />
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{link.label}</strong>
      </span>
    </>
  );
  return (
    <section className="fdy-chat-context-section">
      <h3>{t("contextCard.startedBy")}</h3>
      <div className="fdy-chat-context-list">
        {link.onOpen ? (
          <Button
            className="fdy-chat-context-row"
            onClick={link.onOpen}
            title={t("contextCard.openStartedBy", { title: link.label })}
            variant="ghost"
          >
            {content}
            <ChevronRight
              aria-hidden="true"
              className="fdy-chat-context-row-forward"
              size={14}
            />
          </Button>
        ) : (
          <div className="fdy-chat-context-row" data-static="true">
            {content}
          </div>
        )}
      </div>
    </section>
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
  return (
    <aside
      className="fdy-chat-context-card"
      aria-label={t("contextCard.label")}
    >
      {onClose ? (
        <Button
          aria-label={t("contextCard.hide")}
          className="fdy-chat-context-close"
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

      {work && (work.list || work.error) ? (
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
        />
      ) : null}

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
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.previews")}</h3>
          <div className="fdy-chat-context-list">
            {data.previews.map((item) => (
              <ResourceRow
                item={item}
                key={item.id}
                kind="preview"
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!work?.list && data.timers.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("work.title")}</h3>
          <div className="fdy-chat-context-list">
            {data.timers.map((item) => (
              <TimerRow
                item={item}
                key={item.id}
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!work?.list && data.subagents.length > 0 ? (
        <SubagentSection
          chatKey={chatKey}
          items={data.subagents}
          onRetry={onRetrySubagents}
          onSelect={onSelect}
          reveal={reveal}
          selectedId={selectedId}
        />
      ) : null}

      {data.sources.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.sources")}</h3>
          <div className="fdy-chat-context-list">
            {data.sources.map((item) => (
              <ResourceRow
                item={item}
                key={item.id}
                kind="source"
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
});
