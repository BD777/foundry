import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../i18n";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { ProgressMeter } from "../../../components/ui/progress-meter";
import { cn } from "../../../lib/cn";
import { ContextSection } from "../../../components/ui/context-card";
import { CopyButton } from "../../../components/ui/copy-button";
import { Tooltip } from "../../../components/ui/tooltip";
import { runtimeMeta } from "../../../components/agent-runtime/runtime-mark";
import {
  formatDuration,
  formatTokenCount,
} from "../../../components/conversation/turn-usage";
import type { ChatSessionStatus } from "../chat-types";
import { navigateToChatMessage } from "../../../lib/in-app-navigation";
import { clockTime } from "../../../lib/time-format";

/** How full the context is: "high" from 80%, "full" from 95%. */
export function contextLevel(
  context: ChatSessionStatus["context"],
): "unknown" | "normal" | "high" | "full" {
  const { usedTokens, contextWindow } = context;
  if (usedTokens === undefined || !contextWindow) return "unknown";
  const share = usedTokens / contextWindow;
  return share >= 0.95 ? "full" : share >= 0.8 ? "high" : "normal";
}

/** "182K / 1M · 18%"; a part not reported yet reads "—". */
export function contextSummary(context: ChatSessionStatus["context"]): string {
  const { usedTokens, contextWindow } = context;
  const unknown = i18n.t("chat:contextCard.status.unknown");
  const used =
    usedTokens === undefined ? unknown : formatTokenCount(usedTokens);
  const window = contextWindow ? formatTokenCount(contextWindow) : unknown;
  if (usedTokens === undefined || !contextWindow)
    return i18n.t("chat:contextCard.status.contextUsed", { used, window });
  const percent = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(usedTokens / contextWindow);
  return i18n.t("chat:contextCard.status.contextValue", {
    used,
    window,
    percent,
  });
}

/**
 * For a window Foundry set (compatible endpoints): the window the runtime runs
 * with and where it came from. A runtime may run with another window than the
 * one set (Claude Code keeps its own for a model it knows; Codex caps at the
 * model's maximum and counts 95% usable), and then both are named.
 */
function windowValue(
  context: ChatSessionStatus["context"],
): string | undefined {
  const { contextWindow, configured } = context;
  if (!contextWindow || !configured) return undefined;
  const window = formatTokenCount(contextWindow);
  const source = i18n.t(
    `chat:contextCard.status.windowSource.${configured.source}`,
  );
  return configured.tokens === contextWindow
    ? i18n.t("chat:contextCard.status.windowValue", { window, source })
    : i18n.t("chat:contextCard.status.windowAdjusted", {
        window,
        configured: formatTokenCount(configured.tokens),
        source,
      });
}

function formatCost(usd: number): string {
  return new Intl.NumberFormat(i18n.language, {
    currency: "USD",
    maximumFractionDigits: usd >= 1 ? 2 : 4,
    style: "currency",
  }).format(usd);
}

function permissionsValue(status: ChatSessionStatus): string {
  const t = i18n.t.bind(i18n);
  // A verifier's record reads full access (Codex) or dontAsk (Claude): the
  // sandbox around the whole process is what keeps the workspace read-only.
  if (status.verification)
    return t("chat:contextCard.status.verificationSandbox");
  if (status.runtime === "claude")
    return status.claudePermissionMode &&
      status.claudePermissionMode !== "default"
      ? t(`agents:permissionShort.claude.${status.claudePermissionMode}`)
      : t("chat:contextCard.status.defaultPermissions");
  if (!status.codexSandboxMode && !status.codexApprovalPolicy)
    return t("chat:contextCard.status.defaultPermissions");
  const sandbox = status.codexSandboxMode
    ? t(`agents:permissionShort.codex.${status.codexSandboxMode}`)
    : t("chat:contextCard.status.defaultPermissions");
  return status.codexApprovalPolicy
    ? t("chat:contextCard.status.permissionsValue", {
        sandbox,
        approval: t(`agents:codexApproval.${status.codexApprovalPolicy}`),
      })
    : sandbox;
}

/** The status's folded rows, label and value; empty ones are left out. */
/** A row's action: copy its value, or show where it happened. */
type StatusRow = {
  id: string;
  label: string;
  value: string;
  copy?: string;
  /** The transcript message the row points at, and the button's name. */
  jump?: { label: string; messageId: string };
};

export function statusRows(status: ChatSessionStatus): StatusRow[] {
  const t = i18n.t.bind(i18n);
  const model = status.model ?? t("chat:contextCard.status.defaultModel");
  const rows: (Omit<StatusRow, "value"> & { value?: string })[] = [
    {
      id: "model",
      label: t("chat:contextCard.status.model"),
      value: status.effort
        ? t("chat:contextCard.status.modelValue", {
            model,
            effort: t(`agents:effort.${status.effort}`),
          })
        : model,
    },
    {
      id: "window",
      label: t("chat:contextCard.status.window"),
      value: windowValue(status.context),
    },
    {
      id: "account",
      label: t("chat:contextCard.status.account"),
      value: status.profileLabel ?? runtimeMeta(status.runtime).label,
    },
    {
      id: "device",
      label: t("chat:contextCard.status.device"),
      value: status.deviceLabel,
    },
    {
      id: "permissions",
      label: t("chat:contextCard.status.permissions"),
      value: permissionsValue(status),
    },
  ];
  if (status.turns > 0) {
    const { totals } = status;
    rows.push(
      {
        id: "turns",
        label: t("chat:contextCard.status.turns"),
        value:
          status.lastTurnDurationMs !== undefined
            ? t("chat:contextCard.status.turnsValue", {
                count: status.turns,
                duration: formatDuration(status.lastTurnDurationMs),
              })
            : String(status.turns),
      },
      {
        id: "tokens",
        label: t("chat:contextCard.status.tokens"),
        value: t("chat:contextCard.status.tokensValue", {
          input: formatTokenCount(totals.inputTokens),
          output: formatTokenCount(totals.outputTokens),
        }),
      },
      {
        id: "cache",
        label: t("chat:contextCard.status.cache"),
        value: t("chat:contextCard.status.cacheValue", {
          read: formatTokenCount(totals.cacheReadTokens),
          write: formatTokenCount(totals.cacheWriteTokens),
        }),
      },
    );
    if (totals.costUsd !== undefined)
      rows.push({
        id: "cost",
        label: t("chat:contextCard.status.cost"),
        value:
          totals.costTurns < status.turns
            ? t("chat:contextCard.status.costPartial", {
                cost: formatCost(totals.costUsd),
                count: totals.costTurns,
                total: status.turns,
              })
            : formatCost(totals.costUsd),
      });
  }
  if (status.compactions > 0) {
    const last = status.lastCompaction;
    const when = last ? clockTime(last.at, { date: "short" }) : "";
    rows.push({
      id: "compactions",
      label: t("chat:contextCard.status.compactions"),
      value: when
        ? t("chat:contextCard.status.compactionsValue", {
            count: status.compactions,
            when,
          })
        : String(status.compactions),
      ...(last
        ? {
            jump: {
              label: t("chat:contextCard.status.showCompaction"),
              messageId: last.messageId,
            },
          }
        : {}),
    });
  }
  rows.push({
    id: "session",
    label: t("chat:contextCard.status.session"),
    value: status.sessionId,
    copy: t("chat:contextCard.status.copySession"),
  });
  if (status.nativeSessionId)
    rows.push({
      id: "native",
      label: t("chat:contextCard.status.nativeSession"),
      value: status.nativeSessionId,
      copy: t("chat:contextCard.status.copyNativeSession"),
    });
  return rows.filter((row): row is StatusRow => Boolean(row.value));
}

/** The status line's colours by fullness: the value, its warning, the meter's fill. */
const levelTone = {
  high: {
    text: "text-warning-text",
    fill: "[&::-webkit-progress-value]:bg-warning-text [&::-moz-progress-bar]:bg-warning-text",
  },
  full: {
    text: "text-error-text",
    fill: "[&::-webkit-progress-value]:bg-error-text [&::-moz-progress-bar]:bg-error-text",
  },
} as const;

/**
 * The open session's status line: how full its context is, always shown,
 * and its model, account, device, permissions, usage and ids folded below.
 */
export function ChatSessionStatusLine({
  onOpenChange,
  open,
  status,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  status: ChatSessionStatus;
}) {
  const { t } = useTranslation("chat");
  const id = useId();
  const level = contextLevel(status.context);
  const { usedTokens, contextWindow } = status.context;
  const tone = level === "high" || level === "full" ? levelTone[level] : null;
  let warning: ReactNode = null;
  if (tone)
    warning = (
      <Alert
        className="fdy-chat-status-warning"
        size="compact"
        title={t(
          level === "full"
            ? "contextCard.status.full"
            : "contextCard.status.nearlyFull",
        )}
        tone={level === "full" ? "error" : "warning"}
      />
    );
  return (
    <ContextSection
      aria-label={t("contextCard.status.label")}
      className="fdy-chat-status grid gap-2 py-3.5"
      data-level={level}
    >
      <Tooltip
        variant="hint"
        content={t(
          contextWindow
            ? "contextCard.status.contextHint"
            : "contextCard.status.contextWindowPending",
        )}
      >
        <Button
          aria-controls={open ? id : undefined}
          aria-expanded={open}
          className="fdy-chat-status-toggle flex w-full min-w-0 justify-start gap-2 rounded-lg px-1.5 active:scale-100 focus-visible:outline-accent-line focus-visible:outline-offset-1"
          onClick={() => onOpenChange(!open)}
          size="sm"
          variant="ghost"
        >
          <span className="flex-none text-sm font-bold text-ink-faint">
            {t("contextCard.status.context")}
          </span>
          <span
            className={cn(
              "fdy-chat-status-value min-w-0 flex-1 truncate text-left text-sm font-semibold text-ink tabular-nums",
              tone?.text,
            )}
          >
            {contextSummary(status.context)}
          </span>
          <span className="inline-flex flex-none text-ink-muted">
            {open ? (
              <ChevronDown aria-hidden="true" size={14} />
            ) : (
              <ChevronRight aria-hidden="true" size={14} />
            )}
          </span>
        </Button>
      </Tooltip>
      {contextWindow ? (
        <ProgressMeter
          aria-label={t("contextCard.status.contextMeter")}
          className={cn(
            "mx-1.5 w-[calc(100%-12px)] rounded-full [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full",
            tone?.fill,
          )}
          max={contextWindow}
          value={Math.min(usedTokens ?? 0, contextWindow)}
        />
      ) : null}
      {warning}
      {open ? (
        <dl className="mt-0.5 grid gap-1 px-1.5 text-xs leading-[1.4]" id={id}>
          {statusRows(status).map((row) => (
            <div
              className="grid min-h-6 min-w-0 grid-cols-[86px_minmax(0,1fr)_auto] items-center gap-2"
              data-row={row.id}
              key={row.id}
            >
              <dt className="font-semibold text-ink-faint">{row.label}</dt>
              <dd
                className="m-0 min-w-0 text-ink tabular-nums wrap-anywhere"
                title={row.jump ? row.jump.label : row.value}
              >
                {row.copy ? (
                  <code className="block truncate text-2xs">{row.value}</code>
                ) : row.jump ? (
                  // The value names where it happened; it opens there.
                  <Button
                    aria-label={`${row.value} · ${row.jump.label}`}
                    className="group/jump -ml-1.5 h-auto rounded-md active:scale-100 max-w-full min-h-6 gap-1 px-1.5 py-0.5 text-left text-xs whitespace-normal text-ink tabular-nums"
                    onClick={() =>
                      navigateToChatMessage(
                        status.sessionId,
                        undefined,
                        row.jump!.messageId,
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    <span>{row.value}</span>
                    <CornerDownRight
                      aria-hidden="true"
                      className="flex-none text-ink-faint group-hover/jump:text-ink"
                      size={13}
                    />
                  </Button>
                ) : (
                  row.value
                )}
              </dd>
              {row.copy ? (
                <CopyButton
                  className="fdy-chat-status-copy size-6 text-ink-faint data-[copied=true]:text-success-text"
                  copiedLabel={t("contextCard.status.copied")}
                  label={row.copy}
                  text={row.value}
                  title={row.copy}
                />
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}
    </ContextSection>
  );
}
