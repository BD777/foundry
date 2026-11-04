import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Sparkles } from "lucide-react";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Panel } from "../../components/ui/panel";
import { SelectMenu } from "../../components/ui/select-menu";
import {
  accountSharers,
  joinNames,
  preferUnsharedDevice,
  sharesSystemAccount,
} from "../../lib/device-sharing";
import { serverErrorText } from "../../lib/errors";
import { PaMuted } from "./pa-muted";
import { Subheading } from "../../components/ui/subheading";
import { FieldLabel } from "../../components/ui/form-field";

const isOnline = (device: DeviceProjection) => device.status === "connected";

/**
 * The first visit: one tap makes the assistant's home on the computer the
 * server suggests (the person's most-online one), or another they pick.
 * A computer whose system account someone else shares is never picked for
 * them: with only such computers, they choose one first. Without a
 * computer of their own, where to connect one.
 */
export function AssistantSetup({
  devices,
  suggestedDeviceId,
  onSetUp,
  onConnectComputer,
}: {
  /** The person's own computers. */
  devices: DeviceProjection[];
  suggestedDeviceId?: string;
  onSetUp: (deviceId: string) => Promise<void>;
  onConnectComputer: () => void;
}) {
  const { t, i18n } = useTranslation("personalAgent");
  const fallback =
    devices.find((device) => device.id === suggestedDeviceId) ??
    preferUnsharedDevice(devices);
  const [chosenId, setChosenId] = useState(fallback?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = devices.find((device) => device.id === chosenId) ?? fallback;

  if (!devices.length)
    return (
      <Panel className="grid justify-items-start gap-3 px-6 py-5.5">
        <Sparkles aria-hidden="true" className="text-brand" size={22} />
        <Subheading as="h2" className="text-lg">
          {t("setup.noComputer.title")}
        </Subheading>
        <PaMuted className="leading-[1.6]" size="sm">
          {t("setup.noComputer.body")}
        </PaMuted>
        <Button onClick={onConnectComputer} variant="primary">
          {t("setup.noComputer.action")}
          <ArrowRight aria-hidden="true" size={15} />
        </Button>
      </Panel>
    );

  async function setUp(): Promise<void> {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      await onSetUp(chosen.id);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="grid justify-items-start gap-3 px-6 py-5.5">
      <Sparkles aria-hidden="true" className="text-brand" size={22} />
      <Subheading as="h2" className="text-lg">
        {t("setup.title")}
      </Subheading>
      <PaMuted className="leading-[1.6]" size="sm">
        {t("setup.body")}
      </PaMuted>
      {devices.length > 1 || !fallback ? (
        <div className="grid min-w-0 justify-items-start gap-1.5">
          <FieldLabel as="span">{t("setup.computer")}</FieldLabel>
          <SelectMenu
            ariaLabel={t("setup.computer")}
            disabled={busy}
            onChange={setChosenId}
            options={devices.map((device) => ({
              value: device.id,
              label: device.label,
              meta: isOnline(device)
                ? t("settings.status.online")
                : t("settings.status.offline"),
            }))}
            placeholder={t("setup.chooseComputer")}
            value={chosen?.id ?? ""}
          />
        </div>
      ) : null}
      {!chosen ? (
        <PaMuted className="leading-[1.6]" size="sm">
          {t("setup.onlyShared")}
        </PaMuted>
      ) : sharesSystemAccount(chosen) ? (
        <PaMuted className="leading-[1.6]" size="sm">
          {t("setup.shared", {
            names: joinNames(accountSharers(chosen), i18n.language),
          })}
        </PaMuted>
      ) : null}
      {!chosen || isOnline(chosen) ? null : (
        <PaMuted className="leading-[1.6]" size="sm">
          {t("setup.offline", { device: chosen.label })}
        </PaMuted>
      )}
      <Button
        aria-busy={busy}
        disabled={busy || !chosen || !isOnline(chosen)}
        onClick={() => void setUp()}
        variant="primary"
      >
        {busy
          ? t("setup.working")
          : chosen
            ? t("setup.action", { device: chosen.label })
            : t("setup.actionUnchosen")}
      </Button>
      {error ? (
        <ToastFeedback tone="error" title={t("setup.failed")}>
          {error}
        </ToastFeedback>
      ) : null}
    </Panel>
  );
}
