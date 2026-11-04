import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { createDevicePairingToken, workerServerURL } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionHeader } from "../../components/ui/page-header";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { clockTime } from "../../lib/time-format";
import { useCopied } from "../../lib/use-copied";
import {
  localWorkerCommand,
  useWorkerRelease,
} from "../../lib/worker-commands";
import { Dialog } from "../../components/ui/dialog";
import { PairingProgress } from "./pairing-progress";

const sectionClass =
  "grid min-w-0 gap-2.5 not-first:mt-5.5 not-first:border-t not-first:border-line not-first:pt-5";

/**
 * Adding a device (a one-time pairing token and the one command that installs
 * the worker this server names, from its own packages or npm; only the
 * token's hash is stored) and checking or repairing one already set up, with
 * the command installed on that machine.
 */
export function AddDeviceDialog({
  onClose,
  renderPaired,
}: {
  onClose: () => void;
  /** The paired device's readiness, shown once pairing completes. */
  renderPaired?: (deviceId: string) => ReactNode;
}) {
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
  }>();
  const { t } = useTranslation(["devices", "common"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copied, copy, reset: resetCopied } = useCopied();
  const worker = useWorkerRelease();
  const switchCommand = worker.update;

  const command =
    pairing && worker.bootstrap
      ? `${worker.bootstrap} install --server ${workerServerURL()} --token ${pairing.token}`
      : "";

  async function issue(): Promise<void> {
    setBusy(true);
    setError("");
    resetCopied();
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

  return (
    <Dialog
      title={t("add.dialogTitle")}
      description={t("add.dialogIntro")}
      busy={busy}
      onClose={onClose}
    >
      <section className={sectionClass}>
        <SectionHeader
          level={3}
          title={t("add.title")}
          description={t("add.intro")}
          help={
            <HelpHint label={t("add.mirrorHelpLabel")}>
              <Trans
                ns="devices"
                i18nKey="add.mirrorNote"
                values={{ flag: "--registry https://registry.npmjs.org/" }}
                components={{ code: <code /> }}
              />
            </HelpHint>
          }
        />
        {pairing && command ? (
          <>
            <TerminalBlock
              lines={[{ id: "setup", prompt: "$", value: command }]}
            />
            <Alert
              size="compact"
              title={t("add.tokenExpiry", {
                time: clockTime(pairing.expiresAt) || pairing.expiresAt,
              })}
            >
              <Trans
                ns="devices"
                i18nKey="add.tokenWorkspace"
                values={{ flag: "--workspace <path>" }}
                components={{ code: <code /> }}
              />
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void copy(command, "install")}>
                {copied("install")
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
            <PairingProgress
              renderPaired={renderPaired}
              token={pairing.token}
            />
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
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
      </section>
      <section className={sectionClass}>
        <SectionHeader
          level={3}
          title={t("add.repairTitle")}
          description={t("add.repairIntro")}
        />
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
            <Alert
              size="compact"
              title={t("add.repairServerBuildTitle", {
                version: worker.release.version,
              })}
            >
              {t("add.repairServerBuild")}
            </Alert>
            <TerminalBlock
              lines={[
                {
                  id: "switch",
                  prompt: "$",
                  value: switchCommand,
                },
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void copy(switchCommand, "switch")}>
                {copied("switch")
                  ? t("common:actions.copied")
                  : t("add.copyCommand")}
              </Button>
            </div>
          </>
        ) : switchCommand ? (
          <Alert
            size="compact"
            title={
              <Trans
                ns="devices"
                i18nKey="add.repairLegacy"
                values={{ update: switchCommand }}
                components={{ code: <code /> }}
              />
            }
          />
        ) : null}
      </section>
    </Dialog>
  );
}
