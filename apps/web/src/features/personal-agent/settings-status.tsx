import type { ToastTone } from "../../components/ui/toast";
import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { OctagonX, Play } from "lucide-react";
import type { DeviceProjection, PersonalAgent } from "@bd777/foundry-protocol";
import { movePersonalAgentHome } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SelectMenu } from "../../components/ui/select-menu";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { SettingsField, SettingsGroup } from "./settings-field";
import type { AssistantController } from "./use-assistant";
import { PaMuted } from "./pa-muted";
import { ButtonRow } from "../../components/ui/button-row";

const online = (device: DeviceProjection) => device.status === "connected";

/** Running or stopped, the stop switch, and which computer it lives on. */
export function StatusSection({
  agent,
  assistant,
  owned,
  onNotice,
}: {
  agent: PersonalAgent;
  assistant: AssistantController;
  /** The person's own computers. */
  owned: DeviceProjection[];
  onNotice: (message: string, tone?: ToastTone) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const stopped = agent.state === "stopped";
  const home = owned.find((device) => device.id === agent.homeDeviceId);
  const others = owned.filter((device) => device.id !== agent.homeDeviceId);
  const [target, setTarget] = useState(
    (others.find(online) ?? others[0])?.id ?? "",
  );
  const [busy, setBusy] = useState<"switch" | "move">();
  const [error, setError] = useState<{ title: string; message: string }>();
  const chosen = others.find((device) => device.id === target) ?? others[0];

  async function run(
    kind: "switch" | "move",
    title: string,
    action: () => Promise<void>,
  ): Promise<void> {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError({ title, message: serverErrorText(reason) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <SettingsGroup>
        <SettingsField label={t("settings.status.state")}>
          <ButtonRow gap="wide">
            <Badge
              title={stopped ? fullWhen(agent.stoppedAt) : undefined}
              tone={stopped ? "warn" : "online"}
            >
              {stopped
                ? t("settings.status.stoppedSince", {
                    when: relativeWhen(agent.stoppedAt),
                  })
                : t("settings.status.running")}
            </Badge>
            {stopped ? (
              <Button
                aria-busy={busy === "switch"}
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("switch", t("loadFailed"), async () => {
                    onNotice(await assistant.resume());
                  })
                }
                size="sm"
                variant="primary"
              >
                <Play aria-hidden="true" size={14} />
                {busy === "switch" ? t("home.resuming") : t("home.resume")}
              </Button>
            ) : (
              <Button
                aria-busy={busy === "switch"}
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("switch", t("loadFailed"), async () => {
                    onNotice(await assistant.stopAll());
                  })
                }
                size="sm"
                variant="secondary"
              >
                <OctagonX aria-hidden="true" size={14} />
                {busy === "switch" ? t("home.stopping") : t("home.stopAll")}
              </Button>
            )}
          </ButtonRow>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsField label={t("settings.status.home")}>
          <ButtonRow gap="wide">
            <strong>{home?.label ?? agent.homeDeviceId}</strong>
            {home ? (
              <Badge tone={online(home) ? "online" : "neutral"}>
                {online(home)
                  ? t("settings.status.online")
                  : t("settings.status.offline")}
              </Badge>
            ) : null}
          </ButtonRow>
        </SettingsField>
        {chosen ? (
          <SettingsField
            hint={
              online(chosen)
                ? t("settings.status.moveHint")
                : t("settings.status.moveOffline", { device: chosen.label })
            }
            label={t("settings.status.move")}
          >
            <ButtonRow gap="wide">
              <SelectMenu
                ariaLabel={t("settings.status.move")}
                className="max-w-full min-w-55"
                disabled={Boolean(busy)}
                onChange={setTarget}
                options={others.map((device) => ({
                  value: device.id,
                  label: device.label,
                  meta: online(device)
                    ? t("settings.status.online")
                    : t("settings.status.offline"),
                }))}
                value={chosen.id}
              />
              <Button
                aria-busy={busy === "move"}
                disabled={Boolean(busy) || !online(chosen)}
                onClick={() =>
                  void run(
                    "move",
                    t("settings.status.moveFailed"),
                    async () => {
                      assistant.replaceAgent(
                        await movePersonalAgentHome(agent.id, {
                          deviceId: chosen.id,
                        }),
                      );
                      await assistant.reload();
                      onNotice(
                        t("settings.status.moved", { device: chosen.label }),
                      );
                    },
                  )
                }
                size="sm"
              >
                {busy === "move"
                  ? t("settings.status.moving")
                  : t("settings.status.moveAction")}
              </Button>
            </ButtonRow>
          </SettingsField>
        ) : (
          <PaMuted>{t("settings.status.noOther")}</PaMuted>
        )}
      </SettingsGroup>
      {error ? (
        <ToastFeedback tone="error" title={error.title}>
          {error.message}
        </ToastFeedback>
      ) : null}
    </>
  );
}
