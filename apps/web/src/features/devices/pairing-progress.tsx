import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DevicePairingStatus } from "@bd777/foundry-protocol";
import {
  devicePairingStatus,
  isNotFoundForCaller,
  setDevicePairingConsent,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { joinNames } from "../../lib/device-sharing";
import { serverErrorText } from "../../lib/errors";

/** How often an open Add device dialog asks where its token stands. */
export const pairingPollMs = 2_000;

/** A token in one of these states changes no more. */
export function pairingSettled(state: DevicePairingStatus["state"]): boolean {
  return state === "paired" || state === "cancelled" || state === "expired";
}

/**
 * Where the token stands, read every couple of seconds while the dialog is
 * open until it settles; a new token starts over.
 */
function usePairingStatus(token: string) {
  const [read, setRead] = useState<{
    token: string;
    status: DevicePairingStatus;
  }>();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await devicePairingStatus(token);
        if (cancelled) return;
        setRead({ token, status });
        if (pairingSettled(status.state)) return;
      } catch (reason) {
        if (cancelled || isNotFoundForCaller(reason)) return;
      }
      timer = setTimeout(() => void poll(), pairingPollMs);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);
  const status = read?.token === token ? read.status : undefined;
  return {
    status,
    update: (next: DevicePairingStatus) => setRead({ token, status: next }),
  };
}

/**
 * What became of the pairing command: when the computer's system account is
 * already used by another person's device, the choice to share it (stated
 * plainly as sharing, never as isolation), then the outcome.
 */
export function PairingProgress({ token }: { token: string }) {
  const { t, i18n } = useTranslation("devices");
  const { status, update } = usePairingStatus(token);
  const [choosing, setChoosing] = useState<"continue" | "cancel">();
  const [acceptedToken, setAcceptedToken] = useState("");
  const [error, setError] = useState("");

  async function choose(accept: boolean): Promise<void> {
    setChoosing(accept ? "continue" : "cancel");
    setError("");
    try {
      const next = await setDevicePairingConsent(token, accept);
      if (accept) setAcceptedToken(token);
      update(next);
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setChoosing(undefined);
    }
  }

  if (!status) return null;
  if (status.state === "paired")
    return (
      <Alert tone="success" title={t("add.consent.pairedTitle")}>
        {t("add.consent.paired")}
      </Alert>
    );
  if (status.state === "cancelled")
    return (
      <Alert title={t("add.consent.cancelledTitle")}>
        {t("add.consent.cancelled")}
      </Alert>
    );
  if (status.state === "expired")
    return (
      <Alert title={t("add.consent.expiredTitle")}>
        {t("add.consent.expired")}
      </Alert>
    );
  if (acceptedToken === token)
    return (
      <Alert title={t("add.consent.acceptedTitle")}>
        {t("add.consent.accepted")}
      </Alert>
    );
  if (status.state !== "needs_consent") return null;
  const names = status.sharedWith ?? [];
  return (
    <>
      <Alert tone="warning" title={t("add.consent.title")}>
        <p>
          {t("add.consent.body", {
            names: joinNames(names, i18n.language),
            count: Math.max(names.length, 1),
          })}
        </p>
        <div className="fdy-account-share-actions">
          <Button
            aria-busy={choosing === "continue"}
            disabled={!!choosing}
            onClick={() => void choose(true)}
            variant="primary"
          >
            {choosing === "continue"
              ? t("add.consent.continuing")
              : t("add.consent.continue")}
          </Button>
          <Button
            aria-busy={choosing === "cancel"}
            disabled={!!choosing}
            onClick={() => void choose(false)}
          >
            {choosing === "cancel"
              ? t("add.consent.cancelling")
              : t("add.consent.cancel")}
          </Button>
        </div>
      </Alert>
      {error ? (
        <Alert tone="error" title={t("add.consent.failed")}>
          {error}
        </Alert>
      ) : null}
    </>
  );
}
