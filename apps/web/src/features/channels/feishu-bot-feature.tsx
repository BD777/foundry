import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalProviderApp,
  FeishuBotRoute,
  WorkspaceFeishuBot,
} from "@bd777/foundry-protocol";
import {
  deleteWorkspaceFeishuBot,
  generateFeishuPairingCode,
  getWorkspaceFeishuBot,
  refreshFeishuChatName,
  saveWorkspaceFeishuBot,
  unbindFeishuChat,
} from "../../api";
import { onStreamEvent } from "../../stream";
import { feishuAppName } from "../../lib/feishu-app-names";
import { useReadOrder } from "../../lib/read-order";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { AgentDefaultFields } from "../../components/workspace/agent-default-fields";
import {
  agentDefaultAt,
  useAgentDefaults,
} from "../../components/workspace/use-agent-defaults";
import type { SetAgentDefaultInput } from "../../api";
import { FeishuAppPanel } from "./feishu-app-panel";
import { FeishuAgentDefaultPanel } from "./feishu-agent-default-panel";
import { FeishuChatsPanel, chatDisplayName } from "./feishu-chats-panel";
import { errorText } from "./feishu-format";
import type { ChannelSectionProps } from "./channel-types";

/**
 * The workspace's Feishu bot channel: the Connectors app it runs on, how the
 * server's connection to that app stands, and the chats routed here.
 */
export function FeishuBotFeature({
  workspaceId,
  workspaceName,
  workspaceNameOf,
  currentUserId,
  onNotice,
  onOpenConnectors,
  deviceId,
  profiles = [],
}: ChannelSectionProps) {
  const { t } = useTranslation("feishu");
  const { t: tAgents } = useTranslation("agents");
  const [bot, setBot] = useState<WorkspaceFeishuBot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [busyChatId, setBusyChatId] = useState("");
  // The server keeps only a hash, so the plaintext code exists only in the
  // response that generated it.
  const [issued, setIssued] = useState<{ code: string; expiresAt: string }>();
  // A read answered after an update (an event, an action's answer) or a
  // later read is older than what is shown.
  const order = useReadOrder();
  // Events carry no choices (they are the caller's); keep the ones read.
  const showBot = (next: WorkspaceFeishuBot) => {
    order.changed();
    setBot((current) => ({
      ...next,
      choices: next.choices ?? current?.choices,
    }));
  };

  useEffect(() => {
    let active = true;
    /** `quiet` reads again behind what is shown, which stays usable. */
    async function load({ quiet = false } = {}) {
      if (!workspaceId) return;
      const current = order.started();
      if (!quiet) setLoading(true);
      try {
        const data = await getWorkspaceFeishuBot(workspaceId);
        if (active && current()) setBot(data);
      } catch (err) {
        if (active)
          onNotice?.(
            t("notices.loadFailed", { error: errorText(err) }),
            "error",
          );
      } finally {
        if (active && !quiet) setLoading(false);
      }
    }
    setIssued(undefined);
    void load();
    const stop = onStreamEvent("feishu_bot_updated", showBot, {
      workspaceId,
      // Changes may have been missed: the bot shown is read again.
      onResync: () => void load({ quiet: true }),
    });
    return () => {
      active = false;
      stop();
    };
  }, [workspaceId]);

  // A paired chat spends the code shown.
  const chatCount = bot?.chats.length ?? 0;
  // The chats' defaults follow the chats paired here.
  const defaults = useAgentDefaults(workspaceId, {
    enabled: Boolean(bot?.app),
    reloadKey: bot?.chats.map((chat) => chat.id).join(","),
    onError: (err) =>
      onNotice?.(
        tAgents("defaultAgent.loadFailed", { error: errorText(err) }),
        "error",
      ),
  });
  const [agentChat, setAgentChat] = useState<FeishuBotRoute>();
  async function saveDefault(input: SetAgentDefaultInput) {
    try {
      await defaults.save(input);
      onNotice?.(tAgents("defaultAgent.saved"));
    } catch (err) {
      onNotice?.(
        tAgents("defaultAgent.saveFailed", { error: errorText(err) }),
        "error",
      );
    }
  }
  useEffect(() => {
    if (!bot?.pairingCodeExpiresAt) setIssued(undefined);
  }, [chatCount, bot?.pairingCodeExpiresAt]);

  async function select(app: ExternalProviderApp) {
    setBusy(true);
    try {
      showBot(await saveWorkspaceFeishuBot(workspaceId, { appId: app.id }));
      setIssued(undefined);
      onNotice?.(t("notices.saved", { app: feishuAppName(app) }));
    } catch (err) {
      onNotice?.(t("notices.saveFailed", { error: errorText(err) }), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const label = bot?.app ? feishuAppName(bot.app) : "";
    setBusy(true);
    try {
      await deleteWorkspaceFeishuBot(workspaceId);
      showBot(await getWorkspaceFeishuBot(workspaceId));
      setIssued(undefined);
      onNotice?.(t("notices.removed", { app: label }));
    } catch (err) {
      onNotice?.(t("notices.removeFailed", { error: errorText(err) }), "error");
    } finally {
      setBusy(false);
    }
  }

  async function generateCode() {
    setPairing(true);
    try {
      const result = await generateFeishuPairingCode(workspaceId);
      setIssued({
        code: result.pairingCode,
        expiresAt: result.pairingCodeExpiresAt,
      });
      setBot(
        (current) =>
          current && {
            ...current,
            pairingCodeExpiresAt: result.pairingCodeExpiresAt,
          },
      );
      onNotice?.(t("notices.codeIssued", { code: result.pairingCode }));
    } catch (err) {
      onNotice?.(t("notices.codeFailed", { error: errorText(err) }), "error");
    } finally {
      setPairing(false);
    }
  }

  async function unbind(chat: FeishuBotRoute) {
    setBusyChatId(chat.id);
    try {
      showBot(await unbindFeishuChat(workspaceId, chat.id));
      onNotice?.(t("notices.unbound", { chat: chatDisplayName(chat, t) }));
    } catch (err) {
      onNotice?.(t("notices.unbindFailed", { error: errorText(err) }), "error");
    } finally {
      setBusyChatId("");
    }
  }

  async function refreshName(chat: FeishuBotRoute) {
    setBusyChatId(chat.id);
    try {
      const next = await refreshFeishuChatName(workspaceId, chat.id);
      showBot(next);
      const after = next.chats.find((item) => item.id === chat.id) ?? chat;
      const name = chatDisplayName(after, t);
      if (after.chatNameError)
        onNotice?.(
          t("notices.nameRefreshFailed", {
            chat: name,
            error: after.chatNameError,
          }),
          "error",
        );
      else if (after.chatName !== chat.chatName)
        onNotice?.(t("notices.nameRefreshed", { chat: name }));
      else onNotice?.(t("notices.nameUnchanged", { chat: name }));
    } catch (err) {
      onNotice?.(
        t("notices.nameRefreshFailed", {
          chat: chatDisplayName(chat, t),
          error: errorText(err),
        }),
        "error",
      );
    } finally {
      setBusyChatId("");
    }
  }

  return (
    <div className="fdy-feishu-container">
      <FeishuAppPanel
        bot={bot}
        busy={busy}
        loading={loading}
        onOpenConnectors={onOpenConnectors}
        onRemove={remove}
        onSelect={select}
      />
      {bot?.app ? (
        <FeishuAgentDefaultPanel
          answer={defaults.answer}
          deviceId={deviceId}
          onChange={(change) => saveDefault({ scope: "feishu_bot", ...change })}
          profiles={profiles}
        />
      ) : null}
      <FeishuChatsPanel
        bot={bot}
        busyChatId={busyChatId}
        currentUserId={currentUserId}
        issued={issued}
        loading={loading}
        onGenerateCode={generateCode}
        onNotice={onNotice}
        onRefreshName={refreshName}
        onUnbind={unbind}
        pairing={pairing}
        workspaceName={workspaceName}
        workspaceNameOf={workspaceNameOf}
        chatAgentOf={(chat) =>
          agentDefaultAt(defaults.answer, "feishu_chat", chat.id)
            ? tAgents("defaultAgent.chatOverride")
            : defaults.answer
              ? tAgents("defaultAgent.usesBot")
              : undefined
        }
        onSetChatAgent={setAgentChat}
      />
      {agentChat ? (
        <Dialog
          description={tAgents("defaultAgent.chatIntro")}
          footer={
            <Button onClick={() => setAgentChat(undefined)} variant="primary">
              {tAgents("defaultAgent.done")}
            </Button>
          }
          layout="compact"
          onClose={() => setAgentChat(undefined)}
          title={tAgents("defaultAgent.chatDialogTitle", {
            chat: chatDisplayName(agentChat, t),
          })}
        >
          {defaults.answer ? (
            <AgentDefaultFields
              accounts={defaults.answer.accounts}
              deviceId={deviceId}
              effective={defaults.answer.feishuChats?.[agentChat.id]}
              effectiveLabel={tAgents("defaultAgent.effectiveTopic")}
              insideDialog
              onChange={(change) =>
                saveDefault({
                  scope: "feishu_chat",
                  routeId: agentChat.id,
                  ...change,
                })
              }
              profiles={profiles}
              value={agentDefaultAt(
                defaults.answer,
                "feishu_chat",
                agentChat.id,
              )}
            />
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
