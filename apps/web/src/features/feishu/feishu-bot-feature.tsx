import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  FeishuPairingCodeResult,
  WorkspaceFeishuConfig,
} from "@bd777/foundry-protocol";
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
  const { t } = useTranslation("feishu");
  return props.readOnlyReason ? (
    <Alert title={t("readOnlyTitle")}>{props.readOnlyReason}</Alert>
  ) : (
    <FeishuBotSettings {...props} />
  );
}

function FeishuBotSettings({
  workspaceId,
  workspaceName,
  onNotice,
}: FeishuBotFeatureProps) {
  const { t } = useTranslation("feishu");
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
      onNotice?.(t("notices.loadFailed", { error: errorText(err) }));
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
      onNotice?.(t("notices.appIdRequired"));
      return;
    }
    setSaving(true);
    try {
      const saved = await saveWorkspaceFeishuBot(workspaceId, {
        appId: appId.trim(),
        appSecret: appSecret.trim() || undefined,
      });
      setBot(saved);
      onNotice?.(t("notices.saved"));
    } catch (err) {
      onNotice?.(t("notices.saveFailed", { error: errorText(err) }));
    } finally {
      setSaving(false);
    }
  }

  async function handleGeneratePairCode() {
    setPairing(true);
    try {
      const res = await generateFeishuPairingCode(workspaceId);
      setIssuedCode(res);
      onNotice?.(t("notices.codeIssued", { code: res.pairingCode }));
    } catch (err) {
      onNotice?.(t("notices.codeFailed", { error: errorText(err) }));
    } finally {
      setPairing(false);
    }
  }

  async function handleUnbind() {
    if (!confirm(t("notices.unbindConfirm"))) return;
    try {
      const updated = await unbindFeishuGroup(workspaceId);
      setBot(updated);
      onNotice?.(t("notices.unbound"));
    } catch (err) {
      onNotice?.(t("notices.unbindFailed", { error: errorText(err) }));
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
