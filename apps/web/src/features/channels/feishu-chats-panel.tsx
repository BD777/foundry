import type { ToastTone } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowRight,
  Copy,
  Link2,
  MessageCircle,
  RefreshCw,
  Users,
} from "lucide-react";
import type {
  FeishuBotRoute,
  WorkspaceFeishuBot,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { navigateToAssistantSettings } from "../../lib/in-app-navigation";
import { useCopied } from "../../lib/use-copied";
import { clockTime } from "./feishu-format";

export interface FeishuChatsPanelProps {
  bot?: WorkspaceFeishuBot;
  /** Plaintext code and expiry from this page's last generate call. */
  issued?: { code: string; expiresAt: string };
  workspaceName?: string;
  /** Names the workspace a chat moved here was paired with. */
  workspaceNameOf?: (workspaceId: string) => string | undefined;
  currentUserId?: string;
  loading: boolean;
  pairing: boolean;
  busyChatId?: string;
  onGenerateCode: () => Promise<void>;
  onUnbind: (chat: FeishuBotRoute) => Promise<void>;
  onRefreshName: (chat: FeishuBotRoute) => Promise<void>;
  onNotice?: (msg: string, tone?: ToastTone) => void;
}

/** The chats routed to the workspace, and pairing another one. */
export function FeishuChatsPanel({
  bot,
  issued,
  workspaceName,
  workspaceNameOf,
  currentUserId,
  loading,
  pairing,
  busyChatId,
  onGenerateCode,
  onUnbind,
  onRefreshName,
  onNotice,
}: FeishuChatsPanelProps) {
  const { t } = useTranslation(["feishu", "common"]);
  const { copied, copy } = useCopied(2000, !onNotice);
  const chats = bot?.chats ?? [];
  const ready = Boolean(bot?.app);
  // The bot's command syntax, the same in every language.
  const pairCommand = issued ? `/pair ${issued.code}` : "";

  async function copyCommand() {
    onNotice?.(
      (await copy(pairCommand))
        ? t("notices.commandCopied")
        : t("notices.commandText", { command: pairCommand }),
    );
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

      {chats.length === 0 ? (
        ready ? (
          <FieldHint>{t("chats.empty")}</FieldHint>
        ) : null
      ) : (
        <ul className="fdy-feishu-chat-list">
          {chats.map((chat) => (
            <ChatRow
              busy={busyChatId === chat.id}
              chat={chat}
              key={chat.id}
              ownChat={Boolean(
                currentUserId && chat.boundUserId === currentUserId,
              )}
              pairedIn={
                chat.workspaceId !== bot?.workspaceId
                  ? (workspaceNameOf?.(chat.workspaceId) ??
                    t("chats.otherWorkspace"))
                  : undefined
              }
              onRefreshName={() => void onRefreshName(chat)}
              onUnbind={() => void onUnbind(chat)}
            />
          ))}
        </ul>
      )}
      {!ready ? (
        <FieldHint>{t("chats.needsApp")}</FieldHint>
      ) : (
        <>
          {chats.length > 0 ? (
            <FieldHint>
              <Trans
                ns="feishu"
                i18nKey="chats.readyHint"
                values={{ command: t("chats.mentionCommand") }}
                components={{ code: <code /> }}
              />
            </FieldHint>
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
            <FieldHint>
              <Trans
                ns="feishu"
                i18nKey="pairing.identityHint"
                components={{ b: <strong /> }}
              />
            </FieldHint>
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
                    {copied()
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
                  <FieldHint as="small">
                    {t("pairing.pending", {
                      time: clockTime(bot.pairingCodeExpiresAt),
                    })}
                  </FieldHint>
                ) : null}
              </div>
            )}
          </section>
        </>
      )}
    </Panel>
  );
}

/**
 * One chat. A direct chat its person's assistant takes says so: under the
 * workspace it was paired with ("answered by the assistant") and under the
 * assistant's, where it is listed too (`pairedIn`) and is managed where it
 * was paired, so it has no actions of its own here.
 */
function ChatRow({
  chat,
  busy,
  ownChat,
  pairedIn,
  onRefreshName,
  onUnbind,
}: {
  chat: FeishuBotRoute;
  busy: boolean;
  /** The signed-in account paired it: the assistant is theirs. */
  ownChat: boolean;
  /** The workspace it was paired with, when that is not this one. */
  pairedIn?: string;
  onRefreshName: () => void;
  onUnbind: () => void;
}) {
  const { t } = useTranslation("feishu");
  const direct = chat.kind === "p2p";
  const Icon = direct ? MessageCircle : Users;
  const name = chatDisplayName(chat, t);
  const shortId = chat.chatId ? chat.chatId.slice(-6) : "";
  const toAssistant = Boolean(chat.assistantWorkspaceId);
  return (
    <li className="fdy-feishu-chat">
      <Icon size={16} aria-hidden />
      <span className="fdy-feishu-chat-identity">
        <strong>{name}</strong>
        <small>
          {direct ? t("chats.direct") : t("chats.group")}
          {shortId ? (
            <span title={chat.chatId}>
              {" · "}
              {t("chats.shortId", { id: shortId })}
            </span>
          ) : null}
        </small>
        {pairedIn !== undefined ? (
          <small>{t("chats.movedHere", { workspace: pairedIn })}</small>
        ) : toAssistant ? (
          <small>
            {ownChat
              ? t("chats.movedToYourAssistant")
              : t("chats.movedToAssistant")}
          </small>
        ) : null}
      </span>
      {toAssistant ? (
        <Badge dot={false} tone="neutral">
          {t("chats.assistantBadge")}
        </Badge>
      ) : null}
      {toAssistant && ownChat ? (
        <Button
          onClick={() => navigateToAssistantSettings("entry")}
          size="sm"
          variant="link"
        >
          {t("chats.assistantSettings")}
          <ArrowRight size={14} aria-hidden />
        </Button>
      ) : null}
      {pairedIn === undefined ? (
        <>
          <Button
            aria-label={`${t("chats.refreshName")} ${name}`}
            disabled={busy}
            onClick={onRefreshName}
            size="sm"
            title={t("chats.refreshName")}
            variant="ghost"
          >
            <RefreshCw size={14} aria-hidden />
          </Button>
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
        </>
      ) : null}
    </li>
  );
}

/** The chat's name as Feishu last gave it, or what kind of chat it is. */
export function chatDisplayName(
  chat: FeishuBotRoute,
  t: TFunction<"feishu">,
): string {
  return (
    chat.chatName ||
    (chat.kind === "p2p"
      ? t("chats.defaultDirectName")
      : t("chats.defaultGroupName"))
  );
}
