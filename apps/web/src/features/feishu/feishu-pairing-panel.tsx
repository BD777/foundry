import { useState } from "react";
import { Copy, Link2, RefreshCw, Unlink } from "lucide-react";
import type { WorkspaceFeishuConfig } from "@foundry/protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Panel, PanelHeader } from "../../components/ui/panel";

export interface FeishuPairingPanelProps {
  bot?: WorkspaceFeishuConfig;
  /** Plaintext code from this page's last generate call. */
  pairingCode?: string;
  workspaceName?: string;
  loading: boolean;
  pairing: boolean;
  onGenerateCode: () => Promise<void>;
  onUnbind: () => Promise<void>;
  onNotice?: (msg: string) => void;
}

export function FeishuPairingPanel({
  bot,
  pairingCode,
  workspaceName,
  loading,
  pairing,
  onGenerateCode,
  onUnbind,
  onNotice,
}: FeishuPairingPanelProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopyPairCommand() {
    if (!pairingCode) return;
    const cmd = `/pair ${pairingCode}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onNotice?.("配对指令已复制到剪贴板");
    } catch {
      onNotice?.(`指令内容：${cmd}`);
    }
  }

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Link2 size={20} />
          <div>
            <h2>飞书群配对 (Group Chat Pairing)</h2>
            <p>
              将一个飞书群关联至工作区{" "}
              <strong>{workspaceName || bot?.workspaceId}</strong>
              。群内的每个话题将独立映射为 Foundry 的 Agent 会话。
            </p>
          </div>
        </div>
        {bot?.chatId ? (
          <Badge tone="online">已绑定群聊</Badge>
        ) : (
          <Badge tone="neutral">未绑定群聊</Badge>
        )}
      </PanelHeader>

      <div className="fdy-feishu-content-body">
        {bot?.chatId ? (
          <div className="fdy-feishu-group-card">
            <div className="fdy-feishu-group-row">
              <div>
                <div className="fdy-feishu-chat-name">
                  {bot.chatName || "飞书群聊"}
                </div>
                <div className="fdy-feishu-chat-id">
                  群 ID: <code>{bot.chatId}</code>
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={onUnbind}
                className="fdy-feishu-action-btn"
              >
                <Unlink size={16} />
                解除绑定
              </Button>
            </div>

            <div className="fdy-feishu-chat-hint">
              💡 <strong>已就绪</strong>：在群内{" "}
              <code>@机器人 &lt;需求&gt;</code>{" "}
              将自动开启一个会话，机器人在该话题（Thread）中流式回复卡片；在话题下的连续跟帖将作为补充指令继续执行。
            </div>
          </div>
        ) : (
          <div className="fdy-feishu-pairing-guide">
            <div className="fdy-feishu-steps-text">
              <p>只需两步即可完成群聊绑定：</p>
              <ol>
                <li>将你的飞书机器人拉入目标飞书群；</li>
                <li>
                  在群内艾特机器人并发送配对指令：
                  <code>@机器人 /pair &lt;配对码&gt;</code>。
                </li>
              </ol>
            </div>

            <p className="fdy-feishu-chat-hint">
              群里的请求将以<strong>生成配对码的账号</strong>
              身份执行，并受该账号在此工作区的权限约束（至少需要 Member）。
            </p>

            {pairingCode ? (
              <div className="fdy-feishu-pair-box">
                <div>
                  <div className="fdy-feishu-pair-label">
                    群配对指令 (10分钟内有效)
                  </div>
                  <div className="fdy-feishu-pair-code">
                    /pair {pairingCode}
                  </div>
                </div>

                <div className="fdy-feishu-pair-actions">
                  <Button
                    variant="secondary"
                    onClick={handleCopyPairCommand}
                    className="fdy-feishu-action-btn"
                  >
                    <Copy size={16} />
                    {copied ? "已复制" : "复制指令"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={onGenerateCode}
                    disabled={pairing}
                  >
                    <RefreshCw size={16} />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="fdy-feishu-generate-actions">
                <Button
                  variant="primary"
                  onClick={onGenerateCode}
                  disabled={loading || pairing}
                >
                  <RefreshCw size={16} />
                  {pairing ? "正在生成..." : "生成群配对码"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
