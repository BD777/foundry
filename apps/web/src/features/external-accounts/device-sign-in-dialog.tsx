import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceConnectorSignIn,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import {
  beginDeviceConnectorSignIn,
  pollDeviceConnectorSignIn,
  dismissDeviceConnectorSignIn,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { AuthorizationChallenge } from "./authorization-challenge";
import { errorText } from "./account-format";

export interface DeviceSignInTarget {
  deviceId: string;
  deviceName: string;
  kind: string;
  label: string;
  authorization?: { id: string; revision: number };
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
      {target ? (
        <DeviceSignIn
          key={`${target.deviceId}:${target.kind}:${target.authorization?.id ?? ""}:${target.authorization?.revision ?? 0}`}
          onSignedIn={onSignedIn}
          target={target}
        />
      ) : null}
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
  const requestId = useRef(crypto.randomUUID());
  const operation = useRef("");
  const done = useRef(onSignedIn);
  done.current = onSignedIn;
  const [resume, setResume] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [signIn, setSignIn] = useState<DeviceConnectorSignIn>();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [challenge, setChallenge] =
    useState<DeviceConnectorSignIn["challenge"]>();
  const dismiss = (id: string) =>
    id
      ? dismissDeviceConnectorSignIn(
          target.deviceId,
          target.kind,
          id,
          target.authorization,
        ).catch(() => {})
      : Promise.resolve();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode remounts the same effect; only a real close dismisses it.
      queueMicrotask(() => {
        if (!mounted.current) void dismiss(operation.current);
      });
    };
  }, []);
  async function restart() {
    await dismiss(operation.current);
    requestId.current = crypto.randomUUID();
    operation.current = "";
    setResume(0);
    setAttempt((count) => count + 1);
  }

  useEffect(() => {
    let cancelled = false;
    const startedRequestId = requestId.current;
    let timer: number | undefined;
    setSignIn(undefined);
    setLink("");
    setChallenge(undefined);
    let expiresAt = "";
    let interval = pollEveryMs;
    setError("");
    const settle = (next: DeviceConnectorSignIn): boolean => {
      if (cancelled) {
        if (!mounted.current || startedRequestId !== requestId.current)
          void dismiss(next.operationId ?? "");
        return false;
      }
      setSignIn(next);
      if (next.challenge) setChallenge(next.challenge);
      if (next.operationId) operation.current = next.operationId;
      if (next.expiresAt) expiresAt = next.expiresAt;
      interval = Math.max(2, next.intervalSeconds ?? 3) * 1000;
      if (next.verificationUrl) setLink(next.verificationUrl);
      if (next.status === "complete") {
        if (
          (target.authorization
            ? next.state?.authorizations?.some(
                (a) =>
                  a.id === target.authorization!.id &&
                  a.revision === target.authorization!.revision &&
                  a.status === "ready",
              )
            : next.state?.signedIn) &&
          next.state?.deviceId === target.deviceId &&
          next.state.kind === target.kind
        ) {
          operation.current = "";
          done.current(next.state);
        } else setError(t("deviceSignIn.unverified"));
        return false;
      }
      if (next.status !== "pending") setLink("");
      return next.status === "pending";
    };
    const poll = async () => {
      if (cancelled) return;
      if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
        settle({ status: "expired", operationId: operation.current });
        return;
      }
      try {
        const next = await pollDeviceConnectorSignIn(
          target.deviceId,
          target.kind,
          operation.current,
          target.authorization,
        );
        if (settle(next)) timer = window.setTimeout(poll, interval);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    };
    void (async () => {
      if (resume > 0 && operation.current) {
        await poll();
        return;
      }
      try {
        const started = await beginDeviceConnectorSignIn(
          target.deviceId,
          target.kind,
          requestId.current,
          target.authorization,
        );
        if (settle(started)) {
          if (started.challenge?.kind === "qr_image") void poll();
          else timer = window.setTimeout(poll, interval);
        }
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target.deviceId, target.kind, attempt, resume]);

  const failure = error
    ? t("deviceSignIn.connectionUncertain", { error })
    : signIn?.status === "expired"
      ? t("deviceSignIn.expired")
      : signIn?.status === "denied"
        ? t("deviceSignIn.denied")
        : signIn?.status === "failed"
          ? t("deviceSignIn.failed", { error: signIn.error ?? "" })
          : "";
  const progress = t(
    `deviceSignIn.phase.${signIn?.phase ?? (link || challenge ? "awaiting_user" : "checking")}`,
    {
      device: target.deviceName,
    },
  );
  if (!link && !challenge && !failure)
    return (
      <p className="fdy-xacc-waiting" role="status">
        {signIn?.error ? t("deviceSignIn.reconnecting") : progress}
      </p>
    );
  return (
    <div className="fdy-xacc-form">
      <AuthorizationChallenge
        active={
          !failure &&
          signIn?.status === "pending" &&
          signIn.phase !== "verifying"
        }
        onImageError={() => setError(t("authorization.imageExpired"))}
        challenge={{
          operationId: operation.current,
          verificationUrl: link,
          imageUrl:
            challenge?.kind === "qr_image" ? challenge.imageUrl : undefined,
          expiresAt: signIn?.expiresAt,
          userCode: signIn?.userCode,
        }}
      >
        <strong>{t("deviceSignIn.approveTitle")}</strong>
        <p>
          {challenge?.kind === "qr_image"
            ? t("authorization.scanNative")
            : t("deviceSignIn.approveBody", { name: target.label })}
        </p>
      </AuthorizationChallenge>
      {challenge?.kind === "local_interaction" ? (
        <Alert tone="info" title={challenge.instruction} />
      ) : null}
      {failure ? (
        <Alert title={failure} tone={error ? "info" : "error"}>
          <Button
            onClick={() => {
              if (error) {
                setResume((count) => count + 1);
                return;
              }
              void restart();
            }}
            size="sm"
          >
            {t("connect.tryAgain")}
          </Button>
        </Alert>
      ) : (
        <p className="fdy-xacc-waiting" role="status">
          {signIn?.error ? t("deviceSignIn.reconnecting") : progress}
        </p>
      )}
    </div>
  );
}
