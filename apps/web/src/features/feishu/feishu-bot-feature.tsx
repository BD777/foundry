import { useEffect, useState } from "react";
import type {
  FeishuPairingCodeResult,
  WorkspaceFeishuConfig,
} from "@foundry/protocol";
import {
  generateFeishuPairingCode,
  getWorkspaceFeishuBot,
  saveWorkspaceFeishuBot,
  subscribeFoundryEvents,
  unbindFeishuGroup,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { FeishuCredentialsPanel } from "./feishu-credentials-panel";
import { FeishuPairingPanel } from "./feishu-pairing-panel";

export interface FeishuBotFeatureProps {
  workspaceId: string;
  /** Why the caller cannot manage this workspace's bot; nothing is loaded. */
  readOnlyReason?: string;
  workspaceName?: string;
  onNotice?: (message: string) => void;
}

export function FeishuBotFeature(props: FeishuBotFeatureProps) {
  return props.readOnlyReason ? (
    <Alert title="Read-only access">{props.readOnlyReason}</Alert>
  ) : (
    <FeishuBotSettings {...props} />
  );
}

function FeishuBotSettings({
  workspaceId,
  workspaceName,
  onNotice,
}: FeishuBotFeatureProps) {
  const [bot, setBot] = useState<WorkspaceFeishuConfig>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  // The server keeps only a hash, so the plaintext code exists only in the
  // response that generated it.
  const [issuedCode, setIssuedCode] = useState<FeishuPairingCodeResult>();

  async function loadConfig() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await getWorkspaceFeishuBot(workspaceId);
      setBot(data);
    } catch (err) {
      onNotice?.(
        `获取飞书 Bot 配置失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setIssuedCode(undefined);
    void loadConfig();
    return subscribeFoundryEvents((event) => {
      if (
        event.type === "feishu_bot_updated" &&
        event.payload.workspaceId === workspaceId
      ) {
        setBot(event.payload);
      }
    });
  }, [workspaceId]);

  async function handleSaveConfig(appId: string, appSecret: string) {
    if (!appId.trim()) {
      onNotice?.("请输入飞书应用 App ID");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveWorkspaceFeishuBot(workspaceId, {
        appId: appId.trim(),
        appSecret: appSecret.trim() || undefined,
      });
      setBot(saved);
      onNotice?.("飞书应用凭据已保存，正在建立长连接...");
    } catch (err) {
      onNotice?.(
        `保存失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleGeneratePairCode() {
    setPairing(true);
    try {
      const res = await generateFeishuPairingCode(workspaceId);
      setIssuedCode(res);
      onNotice?.(`配对码 ${res.pairingCode} 已生成，请在飞书群内发送`);
    } catch (err) {
      onNotice?.(
        `生成配对码失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPairing(false);
    }
  }

  async function handleUnbind() {
    if (!confirm("确定要解除当前飞书群与工作区的绑定吗？")) return;
    try {
      const updated = await unbindFeishuGroup(workspaceId);
      setBot(updated);
      onNotice?.("已解除飞书群关联");
    } catch (err) {
      onNotice?.(
        `解除绑定失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="fdy-feishu-container">
      <FeishuCredentialsPanel
        bot={bot}
        loading={loading}
        saving={saving}
        onSave={handleSaveConfig}
      />
      <FeishuPairingPanel
        bot={bot}
        pairingCode={bot?.chatId ? undefined : issuedCode?.pairingCode}
        workspaceName={workspaceName}
        loading={loading}
        pairing={pairing}
        onGenerateCode={handleGeneratePairCode}
        onUnbind={handleUnbind}
        onNotice={onNotice}
      />
    </div>
  );
}
