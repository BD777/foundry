import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { createDevicePairingToken, workerServerURL } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { i18n } from "../../i18n";
import {
  localWorkerCommand,
  useWorkerRelease,
} from "../../lib/worker-commands";
import { WorkspaceDialog } from "./workspace-dialog";

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
 * Adding a device (a one-time pairing token and the one command that installs
 * the worker this server names, from its own packages or npm; only the
 * token's hash is stored) and checking or repairing one already set up, with
 * the command installed on that machine.
 */
export function AddDeviceDialog({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
  }>();
  const { t } = useTranslation(["devices", "common"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"install" | "switch">();
  const worker = useWorkerRelease();
  const switchCommand = worker.update;

  const command =
    pairing && worker.bootstrap
      ? `${worker.bootstrap} install --server ${workerServerURL()} --token ${pairing.token}`
      : "";

  async function issue(): Promise<void> {
    setBusy(true);
    setError("");
    setCopied(undefined);
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

  async function copy(
    which: "install" | "switch",
    text: string,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
    } catch {
      setCopied(undefined);
    }
  }

  return (
    <WorkspaceDialog
      title={t("add.dialogTitle")}
      description={t("add.dialogIntro")}
      busy={busy}
      onClose={onClose}
    >
      <section className="fdy-add-device-section">
        <h3>{t("add.title")}</h3>
        <p>{t("add.intro")}</p>
        {pairing && command ? (
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
            <div className="fdy-add-device-actions">
              <Button onClick={() => void copy("install", command)}>
                {copied === "install"
                  ? t("common:actions.copied")
                  : t("add.copyCommand")}
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
        {error || worker.error ? (
          <Alert tone="error" title={t("add.failedTitle")}>
            {error || worker.error}
          </Alert>
        ) : null}
        <p className="fdy-add-device-note">
          <Trans
            ns="devices"
            i18nKey="add.mirrorNote"
            values={{ flag: "--registry https://registry.npmjs.org/" }}
            components={{ code: <code /> }}
          />
        </p>
      </section>
      <section className="fdy-add-device-section">
        <h3>{t("add.repairTitle")}</h3>
        <p>{t("add.repairIntro")}</p>
        <TerminalBlock
          lines={[
            {
              id: "doctor",
              prompt: "$",
              value: `${localWorkerCommand} doctor`,
            },
            {
              id: "update",
              prompt: "$",
              value: `${localWorkerCommand} update`,
            },
          ]}
        />
        {worker.release?.source === "server" && switchCommand ? (
          <>
            <p className="fdy-add-device-note">
              {t("add.repairServerBuild", {
                version: worker.release.version,
              })}
            </p>
            <TerminalBlock
              lines={[
                {
                  id: "switch",
                  prompt: "$",
                  value: switchCommand,
                },
              ]}
            />
            <div className="fdy-add-device-actions">
              <Button onClick={() => void copy("switch", switchCommand)}>
                {copied === "switch"
                  ? t("common:actions.copied")
                  : t("add.copyCommand")}
              </Button>
            </div>
          </>
        ) : switchCommand ? (
          <p className="fdy-add-device-note">
            <Trans
              ns="devices"
              i18nKey="add.repairLegacy"
              values={{ update: switchCommand }}
              components={{ code: <code /> }}
            />
          </p>
        ) : null}
      </section>
    </WorkspaceDialog>
  );
}
