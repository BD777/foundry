import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { workerPackageName } from "@bd777/foundry-protocol";
import { createDevicePairingToken, workerServerURL } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Panel } from "../../components/ui/panel";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { i18n } from "../../i18n";

function expiryLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Issues a one-time pairing token and shows the one command that installs a
 * worker on another machine from npm. The token is shown once; only its hash
 * is stored.
 */
export function AddDevicePanel({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
  }>();
  const { t } = useTranslation(["devices", "common"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const npx = `npx -y ${workerPackageName}@latest`;
  const command = pairing
    ? `${npx} install --server ${workerServerURL()} --token ${pairing.token}`
    : "";

  async function issue(): Promise<void> {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setPairing(await createDevicePairingToken());
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : t("common:errors.serverUnreachable"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Panel className="fdy-add-device">
      <div className="fdy-add-device-head">
        <div>
          <strong>{t("add.title")}</strong>
          <p>{t("add.intro")}</p>
        </div>
        <Button onClick={onClose} size="sm" variant="ghost">
          {t("common:actions.close")}
        </Button>
      </div>
      {pairing ? (
        <>
          <TerminalBlock
            lines={[{ id: "setup", prompt: "$", value: command }]}
          />
          <p className="fdy-add-device-note">
            <Trans
              ns="devices"
              i18nKey="add.tokenNote"
              values={{
                time: expiryLabel(pairing.expiresAt),
                flag: "--workspace <path>",
              }}
              components={{ code: <code /> }}
            />
          </p>
          <p className="fdy-add-device-note">
            <Trans
              ns="devices"
              i18nKey="add.updateNote"
              values={{
                update: `${npx} update`,
                uninstall: `${npx} uninstall`,
              }}
              components={{ code: <code /> }}
            />
          </p>
          <div className="fdy-add-device-actions">
            <Button onClick={() => void copy()}>
              {copied ? t("common:actions.copied") : t("add.copyCommand")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void issue()}
              variant="ghost"
            >
              {t("add.newToken")}
            </Button>
          </div>
        </>
      ) : (
        <div className="fdy-add-device-actions">
          <Button
            disabled={busy}
            onClick={() => void issue()}
            variant="primary"
          >
            {busy ? t("add.creating") : t("add.create")}
          </Button>
        </div>
      )}
      {error ? (
        <Alert tone="error" title={t("add.failedTitle")}>
          {error}
        </Alert>
      ) : null}
    </Panel>
  );
}
