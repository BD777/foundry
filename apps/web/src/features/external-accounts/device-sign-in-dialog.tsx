import { ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorSignIn,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import {
  beginDeviceConnectorSignIn,
  pollDeviceConnectorSignIn,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useCopied } from "../../lib/use-copied";
import { errorText } from "./account-format";

export interface DeviceSignInTarget {
  deviceId: string;
  deviceName: string;
  kind: string;
  label: string;
}

const pollEveryMs = 3_000;

/**
 * Signs a device's tool in through Foundry: the device starts the tool's
 * own sign-in, the person approves on the page it names (here, or on their
 * phone through the QR code), and the dialog asks the device every few
 * seconds until the tool says it is done. The login stays on the device.
 */
export function DeviceSignInDialog({
  target,
  onClose,
  onSignedIn,
}: {
  target?: DeviceSignInTarget;
  onClose: () => void;
  onSignedIn: (state: DeviceConnectorState | undefined) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  return (
    <Dialog
      description={
        target
          ? t("deviceSignIn.description", {
              name: target.label,
              device: target.deviceName,
            })
          : ""
      }
      layout="compact"
      onClose={onClose}
      open={Boolean(target)}
      title={target ? t("deviceSignIn.title", { name: target.label }) : ""}
    >
      {target ? <DeviceSignIn onSignedIn={onSignedIn} target={target} /> : null}
    </Dialog>
  );
}

function DeviceSignIn({
  target,
  onSignedIn,
}: {
  target: DeviceSignInTarget;
  onSignedIn: (state: DeviceConnectorState | undefined) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  const { copied, copy } = useCopied();
  const [attempt, setAttempt] = useState(0);
  const [signIn, setSignIn] = useState<DeviceConnectorSignIn>();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setSignIn(undefined);
    setLink("");
    setError("");
    const settle = (next: DeviceConnectorSignIn): boolean => {
      if (cancelled) return false;
      setSignIn(next);
      if (next.verificationUrl) setLink(next.verificationUrl);
      if (next.status === "complete") {
        onSignedIn(next.state);
        return false;
      }
      return next.status === "pending";
    };
    const poll = async () => {
      try {
        const next = await pollDeviceConnectorSignIn(
          target.deviceId,
          target.kind,
        );
        if (settle(next)) timer = window.setTimeout(poll, pollEveryMs);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    };
    void (async () => {
      try {
        const started = await beginDeviceConnectorSignIn(
          target.deviceId,
          target.kind,
        );
        if (settle(started)) timer = window.setTimeout(poll, pollEveryMs);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target.deviceId, target.kind, attempt]);

  const failure = error
    ? t("deviceSignIn.failed", { error })
    : signIn?.status === "expired"
      ? t("deviceSignIn.expired")
      : signIn?.status === "denied"
        ? t("deviceSignIn.denied")
        : signIn?.status === "failed"
          ? t("deviceSignIn.failed", { error: signIn.error ?? "" })
          : "";
  if (!link && !failure)
    return (
      <p className="fdy-xacc-waiting" role="status">
        {t("deviceSignIn.starting", { device: target.deviceName })}
      </p>
    );
  return (
    <div className="fdy-xacc-form">
      {link ? (
        <div className="fdy-xacc-scan">
          <div
            className="fdy-xacc-qr"
            data-dimmed={failure ? "true" : undefined}
          >
            <QRCodeSVG
              bgColor="#ffffff"
              fgColor="#111111"
              level="M"
              marginSize={2}
              size={176}
              title={t("connect.qrTitle")}
              value={link}
            />
          </div>
          <div className="fdy-xacc-code-copy">
            <strong>{t("deviceSignIn.approveTitle")}</strong>
            <p>{t("deviceSignIn.approveBody", { name: target.label })}</p>
            <div className="fdy-xacc-code-actions">
              <Button asChild size="sm" variant="primary">
                <a href={link} rel="noreferrer" target="_blank">
                  <ExternalLink size={14} />
                  {t("connect.openPage")}
                </a>
              </Button>
              <Button onClick={() => void copy(link)} size="sm" variant="ghost">
                {copied() ? t("common:actions.copied") : t("connect.copyLink")}
              </Button>
            </div>
            {signIn?.userCode ? (
              <small className="fdy-xacc-user-code">
                {t("connect.userCode")} <code>{signIn.userCode}</code>
              </small>
            ) : null}
          </div>
        </div>
      ) : null}
      {failure ? (
        <Alert title={failure} tone="error">
          <Button onClick={() => setAttempt((count) => count + 1)} size="sm">
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : (
        <p className="fdy-xacc-waiting" role="status">
          {t("deviceSignIn.waiting")}
        </p>
      )}
    </div>
  );
}
