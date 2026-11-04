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
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { ButtonRow } from "../../components/ui/button-row";
import { DividedList } from "../../components/ui/divided-list";
import { HelpHint } from "../../components/ui/help-hint";
import { Identity } from "../../components/ui/identity";
import { SectionHeader } from "../../components/ui/page-header";
import { RowMenu } from "../../components/ui/row-menu";
import { SectionPanel } from "../../components/ui/section-panel";
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
  /** Which agent a chat's new topics use, in a few words. */
  chatAgentOf?: (chat: FeishuBotRoute) => string | undefined;
  /** Opens a chat's own default agent. */
  onSetChatAgent?: (chat: FeishuBotRoute) => void;
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
  chatAgentOf,
  onSetChatAgent,
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
    <SectionPanel spacing="wide">
      <div className="flex min-w-0 items-start gap-3">
        <Link2 className="mt-1 flex-none" size={20} aria-hidden />
        <SectionHeader
          className="min-w-0 flex-1"
          title={t("chats.title")}
          description={
            <Trans
              ns="feishu"
              i18nKey="chats.intro"
              values={{ workspace: workspaceName || bot?.workspaceId }}
              components={{ b: <strong /> }}
            />
          }
          help={
            ready ? (
              <HelpHint label={t("chats.helpLabel")}>
                <Trans
                  ns="feishu"
                  i18nKey="chats.readyHint"
                  values={{ command: t("chats.mentionCommand") }}
                  components={{ code: <code /> }}
                />
              </HelpHint>
            ) : undefined
          }
          actions={
            <Badge tone={chats.length > 0 ? "online" : "neutral"}>
              {t("chats.count", { count: chats.length })}
            </Badge>
          }
        />
      </div>

      {chats.length === 0 ? (
        ready ? (
          <Alert size="compact" title={t("chats.empty")} />
        ) : null
      ) : (
        <DividedList density="cozy">
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
              agent={chatAgentOf?.(chat)}
              onSetAgent={
                onSetChatAgent ? () => onSetChatAgent(chat) : undefined
              }
            />
          ))}
        </DividedList>
      )}
      {!ready ? (
        <Alert size="compact" title={t("chats.needsApp")} />
      ) : (
        <>
          <section
            className="grid gap-2.5 border-t border-line-soft pt-3.5"
            aria-labelledby="feishu-pairing-title"
          >
            <SectionHeader
              level={3}
              title={t("pairing.title")}
              titleId="feishu-pairing-title"
              help={
                <HelpHint label={t("pairing.helpLabel")}>
                  <Trans
                    ns="feishu"
                    i18nKey="pairing.identityHint"
                    components={{ b: <strong /> }}
                  />
                </HelpHint>
              }
            />
            <ol className="list-decimal pl-5 text-sm leading-[1.6]">
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
            {issued ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-accent-line bg-info-surface px-4.5 py-3.5">
                <div>
                  <div className="text-xs text-ink-muted">
                    {t("pairing.commandLabel", {
                      time: clockTime(issued.expiresAt),
                    })}
                  </div>
                  <div className="mt-1 font-mono text-2xl font-bold text-ink wrap-anywhere">
                    {pairCommand}
                  </div>
                </div>
                <ButtonRow className="gap-x-3">
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
                </ButtonRow>
              </div>
            ) : (
              <ButtonRow className="gap-x-3">
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
              </ButtonRow>
            )}
          </section>
        </>
      )}
    </SectionPanel>
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
  agent,
  onSetAgent,
}: {
  chat: FeishuBotRoute;
  /** Which agent the chat's new topics use, in a few words. */
  agent?: string;
  onSetAgent?: () => void;
  busy: boolean;
  /** The signed-in account paired it: the assistant is theirs. */
  ownChat: boolean;
  /** The workspace it was paired with, when that is not this one. */
  pairedIn?: string;
  onRefreshName: () => void;
  onUnbind: () => void;
}) {
  const { t } = useTranslation("feishu");
  const { t: tAgents } = useTranslation("agents");
  const direct = chat.kind === "p2p";
  const Icon = direct ? MessageCircle : Users;
  const name = chatDisplayName(chat, t);
  const shortId = chat.chatId ? chat.chatId.slice(-6) : "";
  const toAssistant = Boolean(chat.assistantWorkspaceId);
  return (
    <li className="flex min-w-0 items-center gap-2.5 text-ink-muted">
      <Icon size={16} aria-hidden />
      <Identity
        as="span"
        className="flex-1 [&>small]:leading-[1.6] [&>strong]:text-md"
      >
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
        {agent && pairedIn === undefined && !toAssistant ? (
          <small>{agent}</small>
        ) : null}
      </Identity>
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
          {onSetAgent && !toAssistant ? (
            <RowMenu
              disabled={busy}
              items={[
                {
                  key: "agent",
                  label: tAgents("defaultAgent.chatMenu"),
                  onSelect: onSetAgent,
                },
              ]}
              label={`${tAgents("defaultAgent.chatMenu")} ${name}`}
            />
          ) : null}
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
