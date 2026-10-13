import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowRight, Bot, ExternalLink } from "lucide-react";
import type {
  ExternalProviderApp,
  WorkspaceFeishuBot,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { SelectMenu } from "../../components/ui/select-menu";
import {
  feishuAppName,
  feishuAppSummary,
  organisationLabel,
  shortAppId,
} from "../../lib/feishu-app-names";
import { relativeWhen, statusTone } from "./feishu-format";

const guideSteps = ["step1", "step2", "step3", "step4"] as const;

export interface FeishuAppPanelProps {
  bot?: WorkspaceFeishuBot;
  loading: boolean;
  busy: boolean;
  onSelect: (app: ExternalProviderApp) => Promise<void>;
  onRemove: () => Promise<void>;
  onOpenConnectors?: () => void;
}

/**
 * Which Connectors app the workspace's Feishu bot channel runs on, and how the server's
 * connection to it stands. Picking or switching takes an explicit action;
 * switching to another Feishu app, which unbinds the chats, takes two.
 */
export function FeishuAppPanel({
  bot,
  loading,
  busy,
  onSelect,
  onRemove,
  onOpenConnectors,
}: FeishuAppPanelProps) {
  const { t } = useTranslation(["feishu", "externalAccounts"]);
  const current = bot?.app;
  const choices = mergeChoices(bot?.choices ?? [], current);
  const [picked, setPicked] = useState(current?.id ?? "");
  useEffect(() => setPicked(current?.id ?? ""), [current?.id]);
  const pickedApp = choices.find((app) => app.id === picked);
  // The caller's own entry names their accounts through the app.
  const shown = choices.find((app) => app.id === current?.id) ?? current;
  const whose = (app: ExternalProviderApp) =>
    app.visibility === "instance" ? t("app.instance") : t("app.personal");
  const changing = Boolean(pickedApp && pickedApp.id !== current?.id);
  const unbinds =
    changing && current && pickedApp?.clientId !== current.clientId
      ? (bot?.chats.length ?? 0)
      : 0;
  const status = bot?.status ?? "unconfigured";
  // Only the app's owner (or an admin, for an organisation app) sees it
  // among the choices and can replace its secret.
  const manages = Boolean(
    current && bot?.choices?.some((app) => app.id === current.id),
  );

  return (
    <Panel className="fdy-feishu-panel">
      <PanelHeader>
        <div className="fdy-feishu-header-title">
          <Bot size={20} aria-hidden />
          <div>
            <h2>{t("app.title")}</h2>
            <p>{t("app.intro")}</p>
          </div>
        </div>
        <Badge tone={statusTone(status)}>{t(`status.${status}`)}</Badge>
      </PanelHeader>

      {shown ? (
        <div className="fdy-feishu-app-facts">
          <span className="fdy-feishu-app-identity">
            <strong>{feishuAppName(shown)}</strong>
            <small>
              {[
                organisationLabel(shown),
                ...(shown.accountNames ?? []),
                whose(shown),
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
          <small className="fdy-feishu-app-event">
            {bot?.lastEventAt
              ? t("app.lastEvent", { when: relativeWhen(bot.lastEventAt) })
              : t("app.noEvent")}
          </small>
          {onOpenConnectors ? (
            <Button onClick={onOpenConnectors} size="sm" variant="link">
              {t("app.manage")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}

      {current && !current.hasSecret ? (
        <Alert title={t("app.secretMissing")} tone="warning">
          {current.rotateSecret ? <p>{t("app.rotateHint")}</p> : null}
          {!manages ? (
            <p>{t("app.otherOwner")}</p>
          ) : onOpenConnectors ? (
            <Button onClick={onOpenConnectors} size="sm">
              {t("app.noSecret")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          ) : null}
        </Alert>
      ) : current && bot?.statusDetail && status === "error" ? (
        <Alert title={bot.statusDetail} tone="warning" />
      ) : null}

      {current?.hasSecret && current.rotateSecret ? (
        <p className="fdy-feishu-rotate" role="status">
          <span>{t("app.rotateHint")}</span>
          {!manages ? (
            <small>{t("app.otherOwner")}</small>
          ) : onOpenConnectors ? (
            <Button onClick={onOpenConnectors} size="sm" variant="link">
              {t("app.rotateAction")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          ) : null}
        </p>
      ) : null}

      {choices.length === 0 && !loading ? (
        <div className="fdy-feishu-empty-choice">
          <p>{t("app.noChoices")}</p>
          {onOpenConnectors ? (
            <Button onClick={onOpenConnectors} size="sm" variant="primary">
              {t("app.connect")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="fdy-feishu-pick">
          <label className="fdy-feishu-label" id="feishu-app-pick">
            {t("app.pick")}
          </label>
          <div className="fdy-feishu-pick-row">
            <SelectMenu
              ariaLabel={t("app.pick")}
              className="fdy-feishu-pick-menu"
              disabled={loading || busy}
              footer={
                onOpenConnectors ? (
                  <Button onClick={onOpenConnectors} size="sm" variant="ghost">
                    {t("app.connect")}
                    <ArrowRight size={14} aria-hidden />
                  </Button>
                ) : undefined
              }
              onChange={setPicked}
              options={choices.map((app) => ({
                value: app.id,
                label: feishuAppSummary(app),
                meta: t("app.optionMeta", {
                  whose: whose(app),
                  id: shortAppId(app.clientId),
                }),
                title: app.clientId,
                detail: app.hasSecret ? undefined : t("app.noSecret"),
              }))}
              placeholder={t("app.pickPlaceholder")}
              value={picked}
            />
            {changing && pickedApp && unbinds > 0 ? (
              <ConfirmButton
                confirmLabel={t("app.switchConfirm", { count: unbinds })}
                disabled={busy}
                onConfirm={() => void onSelect(pickedApp)}
                size="sm"
                variant="primary"
              >
                {t("app.switch")}
              </ConfirmButton>
            ) : changing && pickedApp ? (
              <Button
                disabled={busy}
                onClick={() => void onSelect(pickedApp)}
                size="sm"
                variant="primary"
              >
                {busy
                  ? t("app.working")
                  : current
                    ? t("app.switch")
                    : t("app.use")}
              </Button>
            ) : null}
          </div>
          {current && (bot?.chats.length ?? 0) > 0 ? (
            <small className="fdy-feishu-hint">{t("app.switchHint")}</small>
          ) : null}
        </div>
      )}

      {current ? (
        <div className="fdy-feishu-panel-footer">
          <ConfirmButton
            confirmLabel={t("app.removeConfirm")}
            disabled={busy}
            onConfirm={() => void onRemove()}
            size="sm"
            variant="ghost"
          >
            {t("app.remove")}
          </ConfirmButton>
        </div>
      ) : (
        <details className="fdy-feishu-guide">
          <summary>{t("app.setupTitle")}</summary>
          <ol className="fdy-feishu-guide-list">
            {guideSteps.map((step) => (
              <li key={step}>
                <Trans
                  ns="feishu"
                  i18nKey={`app.guide.${step}`}
                  components={{ b: <strong />, code: <code /> }}
                />
              </li>
            ))}
          </ol>
          <a
            className="fdy-feishu-external-link"
            href="https://open.feishu.cn/app"
            rel="noreferrer"
            target="_blank"
          >
            {t("app.openPlatform")} <ExternalLink size={12} aria-hidden />
          </a>
        </details>
      )}
    </Panel>
  );
}

/** The caller's choices, plus the app the bot runs on when it is someone
 * else's: it stays selectable as what is set. */
function mergeChoices(
  choices: ExternalProviderApp[],
  current: ExternalProviderApp | undefined,
): ExternalProviderApp[] {
  if (!current || choices.some((app) => app.id === current.id)) return choices;
  return [current, ...choices];
}
