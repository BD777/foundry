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
  saveWorkspaceFeishuBot,
  unbindFeishuChat,
} from "../../api";
import { onStreamEvent } from "../../stream";
import { useReadOrder } from "../../lib/read-order";
import { Alert } from "../../components/ui/alert";
import { FeishuAppPanel } from "./feishu-app-panel";
import { FeishuChatsPanel } from "./feishu-chats-panel";
import { errorText } from "./feishu-format";

export interface FeishuBotFeatureProps {
  workspaceId: string;
  /** Why the caller cannot manage this workspace's bot; nothing is loaded. */
  readOnlyReason?: string;
  workspaceName?: string;
  onNotice?: (message: string) => void;
  /** Opens Connectors, where Feishu apps are connected and their secrets
   * replaced. */
  onOpenConnectors?: () => void;
}

export function FeishuBotFeature(props: FeishuBotFeatureProps) {
  const { t } = useTranslation("feishu");
  return props.readOnlyReason ? (
    <Alert title={t("readOnlyTitle")}>{props.readOnlyReason}</Alert>
  ) : (
    <FeishuBotSettings {...props} />
  );
}

/**
 * The workspace's Feishu Bot: the Connectors app it runs on, how the
 * server's connection to that app stands, and the chats routed here.
 */
function FeishuBotSettings({
  workspaceId,
  workspaceName,
  onNotice,
  onOpenConnectors,
}: FeishuBotFeatureProps) {
  const { t } = useTranslation("feishu");
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
          onNotice?.(t("notices.loadFailed", { error: errorText(err) }));
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
  useEffect(() => {
    if (!bot?.pairingCodeExpiresAt) setIssued(undefined);
  }, [chatCount, bot?.pairingCodeExpiresAt]);

  async function select(app: ExternalProviderApp) {
    setBusy(true);
    try {
      showBot(await saveWorkspaceFeishuBot(workspaceId, { appId: app.id }));
      setIssued(undefined);
      onNotice?.(t("notices.saved", { app: app.label }));
    } catch (err) {
      onNotice?.(t("notices.saveFailed", { error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const label = bot?.app?.label ?? "";
    setBusy(true);
    try {
      await deleteWorkspaceFeishuBot(workspaceId);
      showBot(await getWorkspaceFeishuBot(workspaceId));
      setIssued(undefined);
      onNotice?.(t("notices.removed", { app: label }));
    } catch (err) {
      onNotice?.(t("notices.removeFailed", { error: errorText(err) }));
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
      onNotice?.(t("notices.codeFailed", { error: errorText(err) }));
    } finally {
      setPairing(false);
    }
  }

  async function unbind(chat: FeishuBotRoute) {
    setBusyChatId(chat.id);
    try {
      showBot(await unbindFeishuChat(workspaceId, chat.id));
      onNotice?.(t("notices.unbound", { chat: chat.chatName || chat.chatId }));
    } catch (err) {
      onNotice?.(t("notices.unbindFailed", { error: errorText(err) }));
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
      <FeishuChatsPanel
        bot={bot}
        busyChatId={busyChatId}
        issued={issued}
        loading={loading}
        onGenerateCode={generateCode}
        onNotice={onNotice}
        onUnbind={unbind}
        pairing={pairing}
        workspaceName={workspaceName}
      />
    </div>
  );
}
