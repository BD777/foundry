import { useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
} from "lucide-react";
import type { WorkspaceFeishuConfig } from "@foundry/protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";

export interface FeishuCredentialsPanelProps {
  bot?: WorkspaceFeishuConfig;
  loading: boolean;
  saving: boolean;
  onSave: (appId: string, appSecret: string) => Promise<void>;
}

export function FeishuCredentialsPanel({
  bot,
  loading,
  saving,
  onSave,
}: FeishuCredentialsPanelProps) {
  const [appId, setAppId] = useState(bot?.appId || "");
  const [appSecret, setAppSecret] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSave(appId, appSecret);
    setAppSecret("");
  }

  const statusTone =
    bot?.status === "connected"
      ? "online"
      : bot?.status === "connecting"
        ? "brass"
        : bot?.status === "error"
          ? "warn"
          : "neutral";

  const statusLabel =
    bot?.status === "connected"
      ? "长连接在线"
      : bot?.status === "connecting"
        ? "正在连接"
        : bot?.status === "error"
          ? "连接异常"
          : "未配置";

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Bot size={20} />
          <div>
            <h2>飞书机器人应用配置</h2>
            <p>
              配置当前工作区专属的飞书自建应用，服务将通过 WebSocket
              长连接接收群话题与消息。
            </p>
          </div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </PanelHeader>

      {bot?.statusDetail ? (
        <div className="fdy-feishu-error-banner" role="alert">
          <AlertCircle size={16} />
          <span>{bot.statusDetail}</span>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="fdy-feishu-form">
        <div className="fdy-feishu-field-group">
          <label className="fdy-feishu-label" htmlFor="feishu-app-id">
            App ID (应用唯一标识)
          </label>
          <TextInput
            id="feishu-app-id"
            tone="boxed"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="例如: cli_a1b2c3d4e5f6g7h8"
            disabled={loading || saving}
            required
          />
        </div>

        <div className="fdy-feishu-field-group">
          <label className="fdy-feishu-label" htmlFor="feishu-app-secret">
            App Secret (应用凭据密钥)
          </label>
          <TextInput
            id="feishu-app-secret"
            tone="boxed"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={
              bot?.hasAppSecret
                ? "•••••••••••••••• (已保存，如需修改请输入新密钥)"
                : "请输入 App Secret"
            }
            disabled={loading || saving}
          />
        </div>

        <div className="fdy-feishu-form-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowGuide((prev) => !prev)}
            className="fdy-feishu-guide-toggle"
          >
            <HelpCircle size={16} />
            {showGuide ? "收起自建应用指引" : "飞书开放平台配置指引"}
          </Button>

          <Button type="submit" variant="primary" disabled={loading || saving}>
            <CheckCircle2 size={16} />
            {saving ? "正在连接..." : "保存并连接"}
          </Button>
        </div>

        {showGuide ? (
          <div className="fdy-feishu-guide-box">
            <h4 className="fdy-feishu-guide-heading">
              <span>飞书机器人自建指引</span>
              <a
                href="https://open.feishu.cn/app"
                target="_blank"
                rel="noreferrer"
                className="fdy-feishu-external-link"
              >
                飞书开放平台 <ExternalLink size={12} />
              </a>
            </h4>
            <ol className="fdy-feishu-guide-list">
              <li>
                在开放平台创建自建应用，并在「添加应用能力」中启用
                <strong>「机器人」</strong>；
              </li>
              <li>
                在「事件与回调」配置中，事件订阅方式选择
                <strong>「长连接模式 (WebSocket)」</strong>；
              </li>
              <li>
                在事件列表中添加 <code>im.message.receive_v1</code>
                （接收消息）事件；
              </li>
              <li>
                在「权限管理」中申请开通 <code>im:message</code>
                （获取和发送单聊/群聊消息）与 <code>im:chat</code> 权限；
                <strong>如需在话题内直接跟帖追问（无需再次 @ 机器人）</strong>
                ，建议额外开通 <code>im:message.group_msg</code>
                （获取群组中所有消息）权限；
              </li>
              <li>
                创建并发布应用版本后，将凭据与密钥填入上方输入框完成连接。
              </li>
            </ol>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
