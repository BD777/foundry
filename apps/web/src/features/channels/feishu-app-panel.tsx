import { FieldHint } from "../../components/ui/field";
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
import { Identity } from "../../components/ui/identity";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import { MutedText } from "../../components/ui/text";
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
    <SectionPanel spacing="wide">
      <div className="flex min-w-0 items-start gap-3">
        <Bot className="mt-1 flex-none" size={20} aria-hidden />
        <SectionHeader
          className="min-w-0 flex-1"
          title={t("app.title")}
          description={t("app.intro")}
          help={<HelpHint label={t("app.helpLabel")}>{t("app.help")}</HelpHint>}
          actions={
            <Badge tone={statusTone(status)}>{t(`status.${status}`)}</Badge>
          }
        />
      </div>

      {shown ? (
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
          <Identity
            as="span"
            className="[&>small]:leading-[1.6] [&>strong]:text-md"
          >
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
          </Identity>
          <MutedText as="small">
            {bot?.lastEventAt
              ? t("app.lastEvent", { when: relativeWhen(bot.lastEventAt) })
              : t("app.noEvent")}
          </MutedText>
          {onOpenConnectors ? (
            <Button onClick={onOpenConnectors} size="sm" variant="link">
              {t("app.manage")}
              <ArrowRight size={14} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}

      {current && !current.hasSecret ? (
        <Alert
          title={t("app.secretMissing")}
          tone="warning"
          actions={
            manages && onOpenConnectors ? (
              <Button onClick={onOpenConnectors} size="sm">
                {t("app.noSecret")}
                <ArrowRight size={14} aria-hidden />
              </Button>
            ) : undefined
          }
        >
          {[
            current.rotateSecret ? t("app.rotateNotice") : "",
            manages ? "" : t("app.otherOwner"),
          ]
            .filter(Boolean)
            .join(" ") || undefined}
        </Alert>
      ) : current && bot?.statusDetail && status === "error" ? (
        <Alert title={bot.statusDetail} tone="warning" />
      ) : null}

      {current?.hasSecret && current.rotateSecret ? (
        <Alert
          size="compact"
          title={t("app.rotateTitle")}
          tone="warning"
          actions={
            manages && onOpenConnectors ? (
              <Button onClick={onOpenConnectors} size="sm" variant="link">
                {t("app.rotateAction")}
                <ArrowRight size={14} aria-hidden />
              </Button>
            ) : undefined
          }
        >
          {[t("app.rotateNotice"), manages ? "" : t("app.otherOwner")]
            .filter(Boolean)
            .join(" ")}
        </Alert>
      ) : null}

      {choices.length === 0 && !loading ? (
        <Alert
          size="compact"
          title={t("app.noChoices")}
          actions={
            onOpenConnectors ? (
              <Button onClick={onOpenConnectors} size="sm" variant="primary">
                {t("app.connect")}
                <ArrowRight size={14} aria-hidden />
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid min-w-0 gap-2">
          <label className="text-sm font-medium text-ink" id="feishu-app-pick">
            {t("app.pick")}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <SelectMenu
              ariaLabel={t("app.pick")}
              className="max-w-105 min-w-0 flex-[1_1_260px]"
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
            <FieldHint as="small">{t("app.switchHint")}</FieldHint>
          ) : null}
        </div>
      )}

      {current ? (
        <div className="flex justify-end">
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
        <details className="text-sm leading-[1.6]">
          <summary className="cursor-pointer font-medium text-ink">
            {t("app.setupTitle")}
          </summary>
          <ol className="my-2 list-decimal pl-5">
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
            className="inline-flex items-center gap-1 text-brand"
            href="https://open.feishu.cn/app"
            rel="noreferrer"
            target="_blank"
          >
            {t("app.openPlatform")} <ExternalLink size={12} aria-hidden />
          </a>
        </details>
      )}
    </SectionPanel>
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
