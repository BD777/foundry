import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceConnectorsView } from "@bd777/foundry-protocol";
import { getDeviceConnectors, installDeviceExtension } from "../../api";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { ButtonRow } from "../ui/button-row";
import { FieldHint } from "../ui/field";
import { LoadingState } from "../ui/loading";
import { MutedText } from "../ui/text";
import { serverErrorText } from "../../lib/errors";
import { navigateToConnectorSetup } from "../../lib/in-app-navigation";
import { connectorSetupNeed } from "./external-connection-setup-model";

/**
 * A connection a connector extension gives (docs/connector-extensions.md,
 * "模型接入") is set up by setting that connector up on the device: what is
 * missing there in plain words, and the one action that does it. A bundled
 * extension installs right here; anything else opens the connector's own
 * place on the Connectors page at this device's row, where one click
 * continues.
 */
export function ConnectorSetupSection({
  connector,
  deviceId,
  deviceName,
}: {
  connector: { kind: string; label: string };
  deviceId: string;
  deviceName: string;
}) {
  const { t } = useTranslation("connectionSetup");
  const [view, setView] = useState<DeviceConnectorsView>();
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await getDeviceConnectors());
      setError("");
    } catch (cause) {
      setError(serverErrorText(cause));
    }
  }, []);

  // Follow the device while an install lands and the connector reports.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      await load();
      if (!cancelled) timer = window.setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  if (!view)
    return error ? (
      <Alert tone="error" size="compact" title={error} />
    ) : (
      <LoadingState label={t("connector.reading", { name: connector.label })} />
    );

  const need = connectorSetupNeed(view, connector.kind, deviceId);
  const words = { name: connector.label, device: deviceName };

  async function install(extensionId: string) {
    setInstalling(true);
    setError("");
    try {
      await installDeviceExtension(deviceId, {
        bundledExtensionId: extensionId,
      });
      await load();
    } catch (cause) {
      setError(serverErrorText(cause));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <section className="grid gap-2">
      <MutedText className="leading-[1.45]" size="sm" tone="ink">
        {need.kind === "offline"
          ? t("connector.offline", words)
          : need.kind === "install"
            ? t("connector.notInstalled", {
                ...words,
                extension: need.extension,
              })
            : need.step === "install"
              ? t("connector.notInstalled", {
                  ...words,
                  extension: connector.label,
                })
              : need.step === "sign_in"
                ? t("connector.notSignedIn", words)
                : t("connector.notReady", words)}
      </MutedText>
      {need.kind === "connectors" && need.detail ? (
        <FieldHint>{need.detail}</FieldHint>
      ) : null}
      {need.kind === "offline" ? null : (
        <ButtonRow className="gap-x-3">
          {need.kind === "install" ? (
            <Button
              variant="primary"
              size="sm"
              busy={installing}
              onClick={() => void install(need.extensionId)}
            >
              {t("connector.install", {
                extension: need.extension,
                device: deviceName,
              })}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigateToConnectorSetup(connector.kind, deviceId)}
            >
              {need.step === "sign_in"
                ? t("connector.signIn", words)
                : t("connector.open", words)}
            </Button>
          )}
          <FieldHint as="span" className="min-w-0 flex-[1_1_240px]">
            {need.kind === "install"
              ? t("connector.installHint", words)
              : t("connector.openHint", words)}
          </FieldHint>
        </ButtonRow>
      )}
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
    </section>
  );
}
