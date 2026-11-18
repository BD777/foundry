import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentNotifyChatResult,
  PersonalAgentNotifyTestResult,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import {
  findPersonalAgentNotifyChat,
  getPersonalAgentNotifyInstances,
  sendPersonalAgentTestNotice,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { FieldHint, TextInput } from "../../components/ui/field";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { ButtonRow } from "../../components/ui/button-row";
import {
  SettingsCheck,
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

/** The notice kinds a connector may receive, in the order they are offered. */
const noticeKinds = ["question", "approval", "hand_over", "ask"] as const;

/** The built-in Foundry bot as a notice sink: it needs no self chat. */
const feishuBotSinkID = "builtin:feishu";

interface NoticeInstance {
  id: string;
  label: string;
  /** The sink the person is best served by, listed first. */
  recommended: boolean;
  /** Why the instance cannot carry notices yet; "" when it can. */
  reason: string;
}

/** The copy key for a reason an instance cannot carry notices yet. */
function instanceReasonKey(
  reason: string,
):
  | "settings.entry.notifyInstanceReasons.waiting_device"
  | "settings.entry.notifyInstanceReasons.connector_not_notifiable"
  | "settings.entry.notifyInstanceReasons.feishu_not_paired"
  | "settings.entry.notifyInstanceReasons.feishu_not_reachable"
  | "settings.entry.notifyInstanceReasons.instance_unavailable" {
  switch (reason) {
    case "waiting_device":
      return "settings.entry.notifyInstanceReasons.waiting_device";
    case "connector_not_notifiable":
      return "settings.entry.notifyInstanceReasons.connector_not_notifiable";
    case "feishu_not_paired":
      return "settings.entry.notifyInstanceReasons.feishu_not_paired";
    case "feishu_not_reachable":
      return "settings.entry.notifyInstanceReasons.feishu_not_reachable";
    default:
      return "settings.entry.notifyInstanceReasons.instance_unavailable";
  }
}

/**
 * The person's extension instances with whether each can carry notices. The
 * server decides and says why not, so an instance is listed whatever its kind.
 */
function useNoticeInstances(assistantId?: string): {
  instances: NoticeInstance[];
  loadFailed: boolean;
} {
  const [state, setState] = useState<{
    instances: NoticeInstance[];
    loadFailed: boolean;
  }>({ instances: [], loadFailed: false });
  useEffect(() => {
    let current = true;
    getPersonalAgentNotifyInstances(assistantId).then(
      (view) => {
        if (!current) return;
        setState({
          instances: view.instances.map((instance) => ({
            id: instance.connectorInstanceId,
            label: instance.label,
            reason: instance.reason ?? "",
            recommended: instance.recommended === true,
          })),
          loadFailed: false,
        });
      },
      () => {
        if (current) setState({ instances: [], loadFailed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [assistantId]);
  return state;
}

type DiscoveryState =
  | { status: "idle" }
  | { status: "busy"; connectorInstanceId: string }
  | {
      status: "done";
      connectorInstanceId: string;
      result: PersonalAgentNotifyChatResult;
    }
  | { status: "failed"; connectorInstanceId: string };

/** The notice setting: which connector receives notices and which kinds. */
export function NotifySection({
  assistantId,
  draft,
  change,
}: {
  assistantId?: string;
  draft: PersonalAgentSettings;
  change: ChangeSettings;
}) {
  const { t } = useTranslation("personalAgent");
  const { instances, loadFailed } = useNoticeInstances(assistantId);
  const sink = draft.notify?.sinks?.[0];
  const selectedID = sink?.connectorInstanceId ?? "";
  const selfChatNeeded = sink !== undefined && selectedID !== feishuBotSinkID;
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    status: "idle",
  });
  const [typedChat, setTypedChat] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    PersonalAgentNotifyTestResult | undefined
  >(undefined);
  const latestInstance = useRef("");

  const options: SelectMenuOption[] = [
    { value: "", label: t("settings.entry.notifyNone") },
    ...instances.map((instance) => ({
      value: instance.id,
      label: instance.recommended
        ? `${instance.label}${t("settings.entry.notifyRecommended")}`
        : instance.label,
      disabled: instance.reason !== "",
      detail: instance.reason
        ? t(instanceReasonKey(instance.reason))
        : undefined,
    })),
  ];

  const discover = (connectorInstanceId: string, chatId = "") => {
    latestInstance.current = connectorInstanceId;
    setDiscovery({ status: "busy", connectorInstanceId });
    setTestResult(undefined);
    findPersonalAgentNotifyChat(assistantId, {
      connectorInstanceId,
      chatId: chatId || undefined,
    }).then(
      (result) => {
        if (latestInstance.current !== connectorInstanceId) return;
        setDiscovery({ status: "done", connectorInstanceId, result });
      },
      () => {
        if (latestInstance.current !== connectorInstanceId) return;
        setDiscovery({ status: "failed", connectorInstanceId });
      },
    );
  };

  const chooseInstance = (connectorInstanceId: string) => {
    setTypedChat("");
    setTestResult(undefined);
    if (!connectorInstanceId) {
      latestInstance.current = "";
      setDiscovery({ status: "idle" });
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
    discover(connectorInstanceId);
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

  const busy = discovery.status === "busy";
  const found =
    discovery.status === "done" &&
    discovery.connectorInstanceId === selectedID &&
    discovery.result.chat
      ? discovery.result.chat
      : undefined;
  const missingReason =
    discovery.status === "done" &&
    discovery.connectorInstanceId === selectedID &&
    !discovery.result.chat
      ? discovery.result.reason
      : discovery.status === "failed" &&
          discovery.connectorInstanceId === selectedID
        ? "connector_unreachable"
        : undefined;

  return (
    <SettingsGroup title={t("settings.entry.notifyTitle")}>
      <SettingsField
        hint={t("settings.entry.notifyHint")}
        label={t("settings.entry.notifyChannel")}
      >
        <SelectMenu
          ariaLabel={t("settings.entry.notifyChannel")}
          className="w-full"
          onChange={chooseInstance}
          options={options}
          value={selectedID}
        />
      </SettingsField>
      {loadFailed ? (
        <FieldHint role="status">
          {t("settings.entry.notifyListFailed")}
        </FieldHint>
      ) : instances.length === 0 ? (
        <FieldHint>{t("settings.entry.notifyNoConnectors")}</FieldHint>
      ) : null}
      {instances
        .filter((instance) => instance.reason !== "")
        .map((instance) => (
          <FieldHint key={instance.id}>
            {t("settings.entry.notifyInstanceUnavailable", {
              name: instance.label,
              reason: t(instanceReasonKey(instance.reason)),
            })}
          </FieldHint>
        ))}
      {sink ? (
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
          {selfChatNeeded && busy ? (
            <FieldHint role="status">
              {t("settings.entry.notifyFinding")}
            </FieldHint>
          ) : null}
          {selfChatNeeded && found ? (
            <FieldHint role="status">
              {t("settings.entry.notifyFound", {
                name: found.name || found.feedId,
              })}
            </FieldHint>
          ) : null}
          {selfChatNeeded && missingReason !== undefined ? (
            <Alert
              size="compact"
              title={t("settings.entry.notifyMissing")}
              tone="warning"
            >
              <p>
                {t(
                  `settings.entry.notifyReasons.${missingReason}`,
                  t("settings.entry.notifyReasons.default"),
                )}
              </p>
              <SettingsField
                htmlFor="fdy-pa-notify-chat"
                label={t("settings.entry.notifyChatId")}
              >
                <ButtonRow gap="wide">
                  <TextInput
                    id="fdy-pa-notify-chat"
                    onChange={(event) => setTypedChat(event.target.value)}
                    tone="boxed"
                    value={typedChat}
                  />
                  <Button
                    disabled={!typedChat.trim() || busy}
                    onClick={() => discover(selectedID, typedChat.trim())}
                    variant="secondary"
                  >
                    {t("settings.entry.notifyUseChat")}
                  </Button>
                </ButtonRow>
              </SettingsField>
            </Alert>
          ) : null}
          <ButtonRow gap="wide">
            <Button
              disabled={testing || busy}
              onClick={sendTest}
              variant="secondary"
            >
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
