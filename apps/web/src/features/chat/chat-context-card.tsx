import {
  Bot,
  Check,
  CircleX,
  Clock,
  ExternalLink,
  FileText,
  FolderClosed,
  LoaderCircle,
  Repeat,
  X,
} from "lucide-react";
import { nextCronFire } from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";

const subagentStatusLabel: Record<ChatSubagentItem["status"], string> = {
  canceled: "已取消",
  completed: "已完成",
  failed: "失败",
  running: "运行中",
};

function ResourceRow({
  item,
  kind,
  onSelect,
  selected,
}: {
  item: ChatContextResourceItem;
  kind: "output" | "source";
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
        ) : kind === "output" ? (
          <FileText size={16} />
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

function SubagentStatusIcon({
  status,
}: {
  status: ChatSubagentItem["status"];
}) {
  if (status === "running") {
    return <LoaderCircle aria-hidden="true" size={13} />;
  }
  if (status === "completed") {
    return <Check aria-hidden="true" size={13} />;
  }
  return <CircleX aria-hidden="true" size={13} />;
}

function formatNextFireLabel(iso?: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) {
    return `今天 ${time}`;
  }
  if (isTomorrow) {
    return `明天 ${time}`;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TimerRow({
  item,
  onSelect,
  selected,
}: {
  item: ChatTimerItem;
  onSelect?: (item: ChatContextSelection) => void;
  selected: boolean;
}) {
  // Recompute from the cron expression on each render: the worker snapshot
  // captures the next fire at emit time, which goes stale within a cycle.
  const liveNext = nextCronFire(item.task.schedule);
  const nextFire = formatNextFireLabel(
    liveNext?.toISOString() ?? item.task.nextFireAt,
  );
  const fireCount = item.fires.length;
  return (
    <Button
      aria-pressed={selected}
      className="fdy-chat-context-row fdy-chat-timer-row"
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect?.(item)}
      title={item.detail ?? item.label}
      variant="ghost"
    >
      <span className="fdy-chat-context-row-icon" data-kind="timer">
        {item.task.recurring ? (
          <Repeat aria-hidden="true" size={16} />
        ) : (
          <Clock aria-hidden="true" size={16} />
        )}
      </span>
      <span className="fdy-chat-context-row-copy">
        <strong>{item.label}</strong>
        <em>
          {nextFire ? `下次 ${nextFire}` : ""}
          {nextFire && fireCount > 0 ? " · " : ""}
          {fireCount > 0 ? `已触发 ${fireCount} 次` : ""}
        </em>
      </span>
    </Button>
  );
}

export function ChatContextCard({
  data,
  onClose,
  onSelect,
  selectedId,
}: {
  data: ChatContextCardData;
  onClose?: () => void;
  onSelect?: (item: ChatContextSelection) => void;
  selectedId?: string;
}) {
  return (
    <aside className="fdy-chat-context-card" aria-label="Chat details">
      {onClose ? (
        <Button
          aria-label="Hide chat details"
          className="fdy-chat-context-close"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X size={16} />
        </Button>
      ) : null}

      {data.outputs.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>输出</h3>
          <div className="fdy-chat-context-list">
            {data.outputs.map((item) => (
              <ResourceRow
                item={item}
                key={item.id}
                kind="output"
                onSelect={onSelect}
                selected={selectedId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {data.timers.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>定时任务</h3>
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
        <section className="fdy-chat-context-section">
          <h3>子智能体</h3>
          <div className="fdy-chat-context-list">
            {data.subagents.map((subagent, index) => (
              <Button
                aria-pressed={selectedId === subagent.id}
                className="fdy-chat-context-row fdy-chat-subagent-row"
                data-status={subagent.status}
                data-selected={selectedId === subagent.id ? "true" : "false"}
                key={subagent.id}
                onClick={() => onSelect?.(subagent)}
                title={subagent.detail ?? subagent.label}
                variant="ghost"
              >
                <span
                  className="fdy-chat-subagent-avatar"
                  data-tone={(index % 3) + 1}
                >
                  <Bot aria-hidden="true" size={15} />
                </span>
                <span className="fdy-chat-context-row-copy">
                  <strong>{subagent.label}</strong>
                </span>
                <span className="fdy-chat-subagent-status">
                  <SubagentStatusIcon status={subagent.status} />
                  {subagentStatusLabel[subagent.status]}
                </span>
              </Button>
            ))}
          </div>
        </section>
      ) : null}

      {data.sources.length > 0 ? (
        <section className="fdy-chat-context-section">
          <h3>来源</h3>
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
}
