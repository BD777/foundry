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
import { nextCronFire } from "@bd777/foundry-protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { subagentUsageSummary } from "../../components/conversation/turn-usage";
import type {
  ChatContextCardData,
  ChatContextSelection,
  ChatContextResourceItem,
  ChatSubagentItem,
  ChatTimerItem,
} from "./chat-types";

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
  const { t } = useTranslation("chat");
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
        {(item.detail && item.detail !== item.label) || item.mentioned ? (
          <em>
            {[
              item.detail !== item.label ? item.detail : undefined,
              item.mentioned ? t("contextCard.mentioned") : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </em>
        ) : null}
      </span>
    </Button>
  );
}

/** Outputs shown before "Show all". */
const collapsedOutputs = 8;

function OutputsSection({
  outputs,
  onSelect,
  selectedId,
}: {
  outputs: ChatContextResourceItem[];
  onSelect?: (item: ChatContextSelection) => void;
  selectedId?: string;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const selectedIndex = outputs.findIndex((item) => item.id === selectedId);
  const shown =
    expanded || selectedIndex >= collapsedOutputs
      ? outputs
      : outputs.slice(0, collapsedOutputs);
  return (
    <section className="fdy-chat-context-section">
      <h3>
        {t("contextCard.outputs")}
        <span className="fdy-chat-context-count">{outputs.length}</span>
      </h3>
      <div className="fdy-chat-context-list">
        {shown.map((item) => (
          <ResourceRow
            item={item}
            key={item.id}
            kind="output"
            onSelect={onSelect}
            selected={selectedId === item.id}
          />
        ))}
      </div>
      {outputs.length > collapsedOutputs ? (
        <Button
          aria-expanded={shown.length === outputs.length}
          className="fdy-chat-context-more"
          onClick={() => setExpanded((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {shown.length === outputs.length
            ? t("contextCard.showFewer")
            : t("contextCard.showAll", { count: outputs.length })}
        </Button>
      ) : null}
    </section>
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
  const time = date.toLocaleTimeString(i18n.language, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) {
    return i18n.t("chat:contextCard.today", { time });
  }
  if (isTomorrow) {
    return i18n.t("chat:contextCard.tomorrow", { time });
  }
  return date.toLocaleString(i18n.language, {
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
  const { t } = useTranslation("chat");
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
          {nextFire ? t("contextCard.nextFire", { time: nextFire }) : ""}
          {nextFire && fireCount > 0 ? " · " : ""}
          {fireCount > 0
            ? t("contextCard.fireCount", { count: fireCount })
            : ""}
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
  const { t } = useTranslation("chat");
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

      {data.outputs.length > 0 ? (
        <OutputsSection
          onSelect={onSelect}
          outputs={data.outputs}
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
        <section className="fdy-chat-context-section">
          <h3>{t("contextCard.subagents")}</h3>
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
                  {subagent.usage ? (
                    <em>{subagentUsageSummary(subagent.usage)}</em>
                  ) : null}
                </span>
                <span className="fdy-chat-subagent-status">
                  <SubagentStatusIcon status={subagent.status} />
                  {t(`contextCard.subagentStatus.${subagent.status}`)}
                </span>
              </Button>
            ))}
          </div>
        </section>
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
}
