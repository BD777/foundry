import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
} from "lucide-react";
import type { WorkspaceFeishuConfig } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Panel, PanelHeader } from "../../components/ui/panel";

const guideSteps = ["step1", "step2", "step3", "step4", "step5"] as const;

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
  const { t } = useTranslation("feishu");
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

  const statusLabel = t(
    bot?.status === "connected"
      ? "credentials.status.connected"
      : bot?.status === "connecting"
        ? "credentials.status.connecting"
        : bot?.status === "error"
          ? "credentials.status.error"
          : "credentials.status.notConfigured",
  );

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Bot size={20} />
          <div>
            <h2>{t("credentials.title")}</h2>
            <p>{t("credentials.intro")}</p>
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
            {t("credentials.appId")}
          </label>
          <TextInput
            id="feishu-app-id"
            tone="boxed"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder={t("credentials.appIdPlaceholder")}
            disabled={loading || saving}
            required
          />
        </div>

        <div className="fdy-feishu-field-group">
          <label className="fdy-feishu-label" htmlFor="feishu-app-secret">
            {t("credentials.appSecret")}
          </label>
          <TextInput
            id="feishu-app-secret"
            tone="boxed"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={
              bot?.hasAppSecret
                ? t("credentials.appSecretSaved")
                : t("credentials.appSecretPlaceholder")
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
            {showGuide
              ? t("credentials.hideGuide")
              : t("credentials.showGuide")}
          </Button>

          <Button type="submit" variant="primary" disabled={loading || saving}>
            <CheckCircle2 size={16} />
            {saving ? t("credentials.saving") : t("credentials.save")}
          </Button>
        </div>

        {showGuide ? (
          <div className="fdy-feishu-guide-box">
            <h4 className="fdy-feishu-guide-heading">
              <span>{t("credentials.guideTitle")}</span>
              <a
                href="https://open.feishu.cn/app"
                target="_blank"
                rel="noreferrer"
                className="fdy-feishu-external-link"
              >
                {t("credentials.openPlatform")} <ExternalLink size={12} />
              </a>
            </h4>
            <ol className="fdy-feishu-guide-list">
              {guideSteps.map((step) => (
                <li key={step}>
                  <Trans
                    ns="feishu"
                    i18nKey={`credentials.guide.${step}`}
                    components={{ b: <strong />, code: <code /> }}
                  />
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
