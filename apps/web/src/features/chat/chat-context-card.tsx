import { ExternalLink, FolderClosed, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ChatSessionStatusLine } from "./chat-session-status";
import { BackgroundSection } from "./chat-context-background";
import { SessionFileSections } from "./chat-context-files";
import { useFoldOpen } from "./chat-context-folds";
import { SubagentSection } from "./chat-context-subagents";
import { TimerRow } from "./chat-context-timers";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
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

export const ChatContextCard = memo(function ChatContextCard({
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

      <SessionFileSections
        data={data}
        onClearTurnFilter={onClearTurnFilter}
        onSelect={onSelect}
        reveal={reveal}
        turnFilter={turnFilter}
      />

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

      {data.background.length > 0 ? (
        <BackgroundSection
          chatKey={chatKey}
          items={data.background}
          onSelect={onSelect}
          reveal={reveal}
          selectedId={selectedId}
        />
      ) : null}

      {data.timers.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.timers")}</h3>
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

      {data.subagents.length > 0 ? (
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
