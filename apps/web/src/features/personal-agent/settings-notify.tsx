import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentNotifyTestResult,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import {
  getPersonalAgentNotifyInstances,
  sendPersonalAgentTestNotice,
  type PendingItem,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { ButtonRow } from "../../components/ui/button-row";
import { unsentNotices } from "../../lib/pending-display";
import {
  SettingsCheck,
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

/** The notice kinds the bot may send, in the order they are offered. */
const noticeKinds = ["question", "approval", "hand_over", "ask"] as const;

/** The only notice sink: the Foundry bot's interactive cards in Feishu. */
const feishuBotSinkID = "builtin:feishu";

interface NoticeInstance {
  id: string;
  label: string;
  /** Why the bot cannot carry notices yet; "" when it can. */
  reason: string;
}

/** The copy key for a reason the bot cannot carry notices yet. */
function instanceReasonKey(
  reason: string,
):
  | "settings.entry.notifyInstanceReasons.feishu_not_paired"
  | "settings.entry.notifyInstanceReasons.feishu_not_reachable"
  | "settings.entry.notifyInstanceReasons.instance_unavailable" {
  switch (reason) {
    case "feishu_not_paired":
      return "settings.entry.notifyInstanceReasons.feishu_not_paired";
    case "feishu_not_reachable":
      return "settings.entry.notifyInstanceReasons.feishu_not_reachable";
    default:
      return "settings.entry.notifyInstanceReasons.instance_unavailable";
  }
}

/** The Foundry bot as the server lists it, with whether it can carry notices. */
function useNoticeBot(assistantId?: string): {
  bot?: NoticeInstance;
  loadFailed: boolean;
} {
  const [state, setState] = useState<{
    bot?: NoticeInstance;
    loadFailed: boolean;
  }>({ loadFailed: false });
  useEffect(() => {
    let current = true;
    getPersonalAgentNotifyInstances(assistantId).then(
      (view) => {
        if (!current) return;
        const bot = view.instances.find(
          (instance) => instance.connectorInstanceId === feishuBotSinkID,
        );
        setState({
          bot: bot && {
            id: bot.connectorInstanceId,
            label: bot.label,
            reason: bot.reason ?? "",
          },
          loadFailed: false,
        });
      },
      () => {
        if (current) setState({ loadFailed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [assistantId]);
  return state;
}

/**
 * The notice setting: whether the Foundry bot sends the person cards and of
 * which kinds, and how many requests of the last 7 days were not sent, why.
 */
export function NotifySection({
  assistantId,
  draft,
  change,
  pendingItems = [],
}: {
  assistantId?: string;
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  /** The person's pending items, for the requests that were not sent. */
  pendingItems?: readonly PendingItem[];
}) {
  const { t } = useTranslation("personalAgent");
  const { t: tPending } = useTranslation("pending");
  const { bot, loadFailed } = useNoticeBot(assistantId);
  const sink = draft.notify?.sinks?.[0];
  const selectedID = sink?.connectorInstanceId ?? "";
  // A sink saved before notices became cards only (an extension's chat).
  const retired = sink !== undefined && selectedID !== feishuBotSinkID;
  const unsent = useMemo(() => unsentNotices(pendingItems), [pendingItems]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    PersonalAgentNotifyTestResult | undefined
  >(undefined);

  const options: SelectMenuOption[] = [
    { value: "", label: t("settings.entry.notifyNone") },
    ...(bot
      ? [
          {
            value: bot.id,
            label: bot.label,
            disabled: bot.reason !== "",
            detail: bot.reason ? t(instanceReasonKey(bot.reason)) : undefined,
          },
        ]
      : []),
    ...(retired
      ? [
          {
            value: selectedID,
            label: t("settings.entry.notifyRetiredOption"),
            disabled: true,
          },
        ]
      : []),
  ];

  const chooseSink = (connectorInstanceId: string) => {
    setTestResult(undefined);
    if (!connectorInstanceId) {
      change({ notify: { sinks: [] } });
      return;
    }
    change({
      notify: {
        sinks: [
          {
            connectorInstanceId,
            kinds: sink?.kinds ?? [...noticeKinds],
          },
        ],
      },
    });
  };

  const toggleKind = (kind: string, checked: boolean) => {
    if (!sink) return;
    const kinds = checked
      ? noticeKinds.filter((item) => item === kind || sink.kinds.includes(item))
      : sink.kinds.filter((item) => item !== kind);
    if (kinds.length === 0) return;
    change({
      notify: {
        sinks: [{ connectorInstanceId: sink.connectorInstanceId, kinds }],
      },
    });
  };

  const sendTest = () => {
    if (!sink) return;
    setTesting(true);
    setTestResult(undefined);
    sendPersonalAgentTestNotice(assistantId, sink.connectorInstanceId).then(
      (result) => {
        setTesting(false);
        setTestResult(result);
      },
      () => {
        setTesting(false);
        setTestResult({ status: "failed", reason: "" });
      },
    );
  };

  return (
    <SettingsGroup title={t("settings.entry.notifyTitle")}>
      <SettingsField
        hint={t("settings.entry.notifyHint")}
        label={t("settings.entry.notifyChannel")}
      >
        <SelectMenu
          ariaLabel={t("settings.entry.notifyChannel")}
          className="w-full"
          onChange={chooseSink}
          options={options}
          value={selectedID}
        />
      </SettingsField>
      {loadFailed ? (
        <FieldHint role="status">
          {t("settings.entry.notifyListFailed")}
        </FieldHint>
      ) : !bot ? (
        <FieldHint>{t("settings.entry.notifyNoBot")}</FieldHint>
      ) : bot.reason ? (
        <FieldHint>
          {t("settings.entry.notifyInstanceUnavailable", {
            name: bot.label,
            reason: t(instanceReasonKey(bot.reason)),
          })}
        </FieldHint>
      ) : null}
      {retired ? (
        <FieldHint role="status">{t("settings.entry.notifyRetired")}</FieldHint>
      ) : null}
      {unsent.count > 0 ? (
        <Alert
          className="fdy-pa-notify-unsent"
          role="status"
          size="compact"
          title={t("settings.entry.notifyUnsent", { count: unsent.count })}
          tone="warning"
        >
          {unsent.reasons.map(({ reason, count }) => (
            <p key={reason}>
              {t("settings.entry.notifyUnsentReason", {
                count,
                reason: tPending(`item.noticeSkipped.${reason}`),
              })}
            </p>
          ))}
        </Alert>
      ) : null}
      {sink && !retired ? (
        <>
          <SettingsField label={t("settings.entry.notifyKinds")}>
            {noticeKinds.map((kind) => (
              <SettingsCheck
                key={kind}
                checked={sink.kinds.includes(kind)}
                label={t(`settings.entry.notifyKindLabels.${kind}`)}
                onChange={(checked) => toggleKind(kind, checked)}
              />
            ))}
          </SettingsField>
          <ButtonRow gap="wide">
            <Button disabled={testing} onClick={sendTest} variant="secondary">
              {testing
                ? t("settings.entry.notifyTesting")
                : t("settings.entry.notifyTest")}
            </Button>
          </ButtonRow>
          {testResult ? (
            testResult.status === "sent" ? (
              <Alert
                size="compact"
                title={t("settings.entry.notifyTest")}
                tone="success"
              >
                {t("settings.entry.notifyTestSent")}
              </Alert>
            ) : (
              <Alert
                size="compact"
                title={t("settings.entry.notifyTest")}
                tone="error"
              >
                {testResult.reason
                  ? t("settings.entry.notifyTestFailedWith", {
                      reason: testResult.reason,
                    })
                  : t("settings.entry.notifyTestFailed")}
              </Alert>
            )
          ) : null}
        </>
      ) : null}
    </SettingsGroup>
  );
}
