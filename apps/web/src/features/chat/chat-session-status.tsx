import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import {
  formatDuration,
  formatTokenCount,
} from "../../components/conversation/turn-usage";
import type { ChatSessionStatus } from "./chat-types";

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

function formatCost(usd: number): string {
  return new Intl.NumberFormat(i18n.language, {
    currency: "USD",
    maximumFractionDigits: usd >= 1 ? 2 : 4,
    style: "currency",
  }).format(usd);
}

function permissionsValue(status: ChatSessionStatus): string {
  const t = i18n.t.bind(i18n);
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
export function statusRows(
  status: ChatSessionStatus,
): { id: string; label: string; value: string; copy?: string }[] {
  const t = i18n.t.bind(i18n);
  const model = status.model ?? t("chat:contextCard.status.defaultModel");
  const rows: {
    id: string;
    label: string;
    value?: string;
    copy?: string;
  }[] = [
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
  if (status.compactions > 0)
    rows.push({
      id: "compactions",
      label: t("chat:contextCard.status.compactions"),
      value: String(status.compactions),
    });
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
  return rows.filter(
    (row): row is { id: string; label: string; value: string; copy?: string } =>
      Boolean(row.value),
  );
}

function CopyValueButton({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label={copied ? t("contextCard.status.copied") : label}
      className="fdy-chat-status-copy"
      data-copied={copied ? "true" : "false"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
      size="icon"
      title={label}
      variant="ghost"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}

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
  let warning: ReactNode = null;
  if (level === "high" || level === "full")
    warning = (
      <p className="fdy-chat-status-warning">
        {t(
          level === "full"
            ? "contextCard.status.full"
            : "contextCard.status.nearlyFull",
        )}
      </p>
    );
  return (
    <section
      aria-label={t("contextCard.status.label")}
      className="fdy-chat-context-section fdy-chat-status"
      data-level={level}
    >
      <Tooltip content={t("contextCard.status.contextHint")}>
        <Button
          aria-controls={open ? id : undefined}
          aria-expanded={open}
          className="fdy-chat-status-toggle"
          onClick={() => onOpenChange(!open)}
          size="sm"
          variant="ghost"
        >
          <span className="fdy-chat-status-name">
            {t("contextCard.status.context")}
          </span>
          <span className="fdy-chat-status-value">
            {contextSummary(status.context)}
          </span>
          <span className="fdy-chat-status-chevron">
            {open ? (
              <ChevronDown aria-hidden="true" size={14} />
            ) : (
              <ChevronRight aria-hidden="true" size={14} />
            )}
          </span>
        </Button>
      </Tooltip>
      {contextWindow ? (
        <progress
          aria-label={t("contextCard.status.contextMeter")}
          className="fdy-chat-status-meter"
          max={contextWindow}
          value={Math.min(usedTokens ?? 0, contextWindow)}
        />
      ) : null}
      {warning}
      {open ? (
        <dl className="fdy-chat-status-details" id={id}>
          {statusRows(status).map((row) => (
            <div data-row={row.id} key={row.id}>
              <dt>{row.label}</dt>
              <dd title={row.value}>
                {row.copy ? <code>{row.value}</code> : row.value}
              </dd>
              {row.copy ? (
                <CopyValueButton label={row.copy} value={row.value} />
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
