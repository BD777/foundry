import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Copy, Link2, RefreshCw, Unlink } from "lucide-react";
import type { WorkspaceFeishuConfig } from "@bd777/foundry-protocol";
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
  const { t } = useTranslation(["feishu", "common"]);
  const [copied, setCopied] = useState(false);
  // The bot's command syntax, the same in every language.
  const pairCommand = `/pair ${pairingCode}`;

  async function handleCopyPairCommand() {
    if (!pairingCode) return;
    const cmd = pairCommand;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onNotice?.(t("notices.commandCopied"));
    } catch {
      onNotice?.(t("notices.commandText", { command: cmd }));
    }
  }

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Link2 size={20} />
          <div>
            <h2>{t("pairing.title")}</h2>
            <p>
              <Trans
                ns="feishu"
                i18nKey="pairing.intro"
                values={{ workspace: workspaceName || bot?.workspaceId }}
                components={{ b: <strong /> }}
              />
            </p>
          </div>
        </div>
        {bot?.chatId ? (
          <Badge tone="online">{t("pairing.bound")}</Badge>
        ) : (
          <Badge tone="neutral">{t("pairing.unbound")}</Badge>
        )}
      </PanelHeader>

      <div className="fdy-feishu-content-body">
        {bot?.chatId ? (
          <div className="fdy-feishu-group-card">
            <div className="fdy-feishu-group-row">
              <div>
                <div className="fdy-feishu-chat-name">
                  {bot.chatName || t("pairing.defaultChatName")}
                </div>
                <div className="fdy-feishu-chat-id">
                  <Trans
                    ns="feishu"
                    i18nKey="pairing.chatId"
                    values={{ id: bot.chatId }}
                    components={{ code: <code /> }}
                  />
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={onUnbind}
                className="fdy-feishu-action-btn"
              >
                <Unlink size={16} />
                {t("pairing.unbind")}
              </Button>
            </div>

            <div className="fdy-feishu-chat-hint">
              <Trans
                ns="feishu"
                i18nKey="pairing.readyHint"
                values={{ command: t("pairing.mentionCommand") }}
                components={{ b: <strong />, code: <code /> }}
              />
            </div>
          </div>
        ) : (
          <div className="fdy-feishu-pairing-guide">
            <div className="fdy-feishu-steps-text">
              <p>{t("pairing.stepsIntro")}</p>
              <ol>
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
            </div>

            <p className="fdy-feishu-chat-hint">
              <Trans
                ns="feishu"
                i18nKey="pairing.identityHint"
                components={{ b: <strong /> }}
              />
            </p>

            {pairingCode ? (
              <div className="fdy-feishu-pair-box">
                <div>
                  <div className="fdy-feishu-pair-label">
                    {t("pairing.commandLabel")}
                  </div>
                  <div className="fdy-feishu-pair-code">{pairCommand}</div>
                </div>

                <div className="fdy-feishu-pair-actions">
                  <Button
                    variant="secondary"
                    onClick={handleCopyPairCommand}
                    className="fdy-feishu-action-btn"
                  >
                    <Copy size={16} />
                    {copied
                      ? t("common:actions.copied")
                      : t("pairing.copyCommand")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={onGenerateCode}
                    disabled={pairing}
                    aria-label={t("pairing.regenerate")}
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
                  {pairing ? t("pairing.generating") : t("pairing.generate")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
