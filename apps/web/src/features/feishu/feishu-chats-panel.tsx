import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Copy, Link2, MessageCircle, RefreshCw, Users } from "lucide-react";
import type {
  FeishuBotRoute,
  WorkspaceFeishuBot,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { clockTime } from "./feishu-format";

export interface FeishuChatsPanelProps {
  bot?: WorkspaceFeishuBot;
  /** Plaintext code and expiry from this page's last generate call. */
  issued?: { code: string; expiresAt: string };
  workspaceName?: string;
  loading: boolean;
  pairing: boolean;
  busyChatId?: string;
  onGenerateCode: () => Promise<void>;
  onUnbind: (chat: FeishuBotRoute) => Promise<void>;
  onNotice?: (msg: string) => void;
}

/** The chats routed to the workspace, and pairing another one. */
export function FeishuChatsPanel({
  bot,
  issued,
  workspaceName,
  loading,
  pairing,
  busyChatId,
  onGenerateCode,
  onUnbind,
  onNotice,
}: FeishuChatsPanelProps) {
  const { t } = useTranslation(["feishu", "common"]);
  const [copied, setCopied] = useState(false);
  const chats = bot?.chats ?? [];
  const ready = Boolean(bot?.app);
  // The bot's command syntax, the same in every language.
  const pairCommand = issued ? `/pair ${issued.code}` : "";

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(pairCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onNotice?.(t("notices.commandCopied"));
    } catch {
      onNotice?.(t("notices.commandText", { command: pairCommand }));
    }
  }

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Link2 size={20} aria-hidden />
          <div>
            <h2>{t("chats.title")}</h2>
            <p>
              <Trans
                ns="feishu"
                i18nKey="chats.intro"
                values={{ workspace: workspaceName || bot?.workspaceId }}
                components={{ b: <strong /> }}
              />
            </p>
          </div>
        </div>
        <Badge tone={chats.length > 0 ? "online" : "neutral"}>
          {t("chats.count", { count: chats.length })}
        </Badge>
      </PanelHeader>

      {!ready ? (
        <p className="fdy-feishu-hint">{t("chats.needsApp")}</p>
      ) : (
        <>
          {chats.length === 0 ? (
            <p className="fdy-feishu-hint">{t("chats.empty")}</p>
          ) : (
            <ul className="fdy-feishu-chat-list">
              {chats.map((chat) => (
                <ChatRow
                  busy={busyChatId === chat.id}
                  chat={chat}
                  key={chat.id}
                  onUnbind={() => void onUnbind(chat)}
                />
              ))}
            </ul>
          )}
          {chats.length > 0 ? (
            <p className="fdy-feishu-hint">
              <Trans
                ns="feishu"
                i18nKey="chats.readyHint"
                values={{ command: t("chats.mentionCommand") }}
                components={{ code: <code /> }}
              />
            </p>
          ) : null}

          <section
            className="fdy-feishu-pairing"
            aria-labelledby="feishu-pairing-title"
          >
            <h3 id="feishu-pairing-title">{t("pairing.title")}</h3>
            <ol className="fdy-feishu-steps">
              <li>{t("pairing.step1")}</li>
              <li>
                <Trans
                  ns="feishu"
                  i18nKey="pairing.step2"
                  values={{ command: t("pairing.pairCommand") }}
                  components={{ code: <code /> }}
                />
              </li>
            </ol>
            <p className="fdy-feishu-hint">
              <Trans
                ns="feishu"
                i18nKey="pairing.identityHint"
                components={{ b: <strong /> }}
              />
            </p>
            {issued ? (
              <div className="fdy-feishu-pair-box">
                <div>
                  <div className="fdy-feishu-pair-label">
                    {t("pairing.commandLabel", {
                      time: clockTime(issued.expiresAt),
                    })}
                  </div>
                  <div className="fdy-feishu-pair-code">{pairCommand}</div>
                </div>
                <div className="fdy-feishu-pair-actions">
                  <Button onClick={() => void copyCommand()} size="sm">
                    <Copy size={14} aria-hidden />
                    {copied
                      ? t("common:actions.copied")
                      : t("pairing.copyCommand")}
                  </Button>
                  <Button
                    aria-label={t("pairing.regenerate")}
                    disabled={pairing}
                    onClick={() => void onGenerateCode()}
                    size="sm"
                    title={t("pairing.regenerate")}
                    variant="ghost"
                  >
                    <RefreshCw size={14} aria-hidden />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="fdy-feishu-generate">
                <Button
                  disabled={loading || pairing}
                  onClick={() => void onGenerateCode()}
                  size="sm"
                  variant="primary"
                >
                  <RefreshCw size={14} aria-hidden />
                  {pairing ? t("pairing.generating") : t("pairing.generate")}
                </Button>
                {bot?.pairingCodeExpiresAt ? (
                  <small className="fdy-feishu-hint">
                    {t("pairing.pending", {
                      time: clockTime(bot.pairingCodeExpiresAt),
                    })}
                  </small>
                ) : null}
              </div>
            )}
          </section>
        </>
      )}
    </Panel>
  );
}

function ChatRow({
  chat,
  busy,
  onUnbind,
}: {
  chat: FeishuBotRoute;
  busy: boolean;
  onUnbind: () => void;
}) {
  const { t } = useTranslation("feishu");
  const direct = chat.kind === "p2p";
  const Icon = direct ? MessageCircle : Users;
  const name =
    chat.chatName ||
    (direct ? t("chats.defaultDirectName") : t("chats.defaultGroupName"));
  return (
    <li className="fdy-feishu-chat">
      <Icon size={16} aria-hidden />
      <span className="fdy-feishu-chat-identity">
        <strong>{name}</strong>
        <small>
          {[direct ? t("chats.direct") : t("chats.group"), chat.chatId]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
      <ConfirmButton
        aria-label={`${t("chats.unbind")} ${name}`}
        confirmLabel={t("chats.unbindConfirm")}
        disabled={busy}
        onConfirm={onUnbind}
        size="sm"
        variant="ghost"
      >
        {t("chats.unbind")}
      </ConfirmButton>
    </li>
  );
}
