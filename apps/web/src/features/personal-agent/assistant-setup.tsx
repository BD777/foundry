import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Sparkles } from "lucide-react";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
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
      <Panel className="fdy-pa-setup">
        <Sparkles aria-hidden="true" className="fdy-pa-setup-icon" size={22} />
        <h2>{t("setup.noComputer.title")}</h2>
        <p>{t("setup.noComputer.body")}</p>
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
    <Panel className="fdy-pa-setup">
      <Sparkles aria-hidden="true" className="fdy-pa-setup-icon" size={22} />
      <h2>{t("setup.title")}</h2>
      <p>{t("setup.body")}</p>
      {devices.length > 1 || !fallback ? (
        <div className="fdy-pa-field">
          <span className="fdy-pa-field-label">{t("setup.computer")}</span>
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
        <p className="fdy-pa-muted">{t("setup.onlyShared")}</p>
      ) : sharesSystemAccount(chosen) ? (
        <p className="fdy-pa-muted">
          {t("setup.shared", {
            names: joinNames(accountSharers(chosen), i18n.language),
          })}
        </p>
      ) : null}
      {!chosen || isOnline(chosen) ? null : (
        <p className="fdy-pa-muted">
          {t("setup.offline", { device: chosen.label })}
        </p>
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
        <Alert tone="error" title={t("setup.failed")}>
          {error}
        </Alert>
      ) : null}
    </Panel>
  );
}
