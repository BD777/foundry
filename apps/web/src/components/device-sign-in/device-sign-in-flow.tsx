import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceConnectorSignIn } from "@bd777/foundry-protocol";
import { errorText } from "../../lib/errors";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { FormField, FormLayout } from "../ui/form-field";
import { LoadingState } from "../ui/loading";
import { MutedText } from "../ui/text";
import { AuthorizationChallenge } from "./authorization-challenge";

/**
 * How a sign-in on a device is driven: a connector's tool (Connectors) or an
 * agent runtime's own login (Model providers). Both answer the same steps.
 */
export interface DeviceSignInTransport {
  begin(requestId: string): Promise<DeviceConnectorSignIn>;
  poll(operationId: string): Promise<DeviceConnectorSignIn>;
  dismiss(operationId: string): Promise<void>;
  submitCode(operationId: string, code: string): Promise<void>;
  /** Whether a complete step shows the login really landed on the device. */
  confirmed(step: DeviceConnectorSignIn): boolean;
}

const pollEveryMs = 3_000;

/**
 * The device starts the tool's own sign-in, the person approves on the page
 * it names (here, or on their phone through the QR code), and the flow asks
 * the device every few seconds until the tool says it is done. The login
 * stays on the device.
 */
export function DeviceSignInFlow({
  transport,
  label,
  deviceName,
  methodLabel,
  onBack,
  onSignedIn,
}: {
  transport: DeviceSignInTransport;
  /** What is signing in, as the person knows it. */
  label: string;
  deviceName: string;
  methodLabel?: string;
  /** Back to choosing how to sign in. */
  onBack?: () => void;
  onSignedIn: (step: DeviceConnectorSignIn) => void;
}) {
  const { t } = useTranslation(["externalAccounts", "common"]);
  // The caller keys this component by what signs in, so the latest
  // transport always names the same sign-in.
  const io = useRef(transport);
  io.current = transport;
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
    id ? io.current.dismiss(id).catch(() => {}) : Promise.resolve();
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
        if (io.current.confirmed(next)) {
          operation.current = "";
          done.current(next);
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
        const next = await io.current.poll(operation.current);
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
        const started = await io.current.begin(requestId.current);
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
  }, [attempt, resume]);

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
      device: deviceName,
    },
  );
  if (!link && !challenge && !failure)
    return (
      <LoadingState
        className="text-xs leading-[1.45] text-ink-muted"
        label={signIn?.error ? t("deviceSignIn.reconnecting") : progress}
      />
    );
  const back = onBack ? (
    <Button
      onClick={() => {
        void dismiss(operation.current);
        operation.current = "";
        onBack();
      }}
      size="sm"
      variant="ghost"
    >
      {t("signInChooser.otherWay")}
    </Button>
  ) : null;
  return (
    <FormLayout>
      {methodLabel ? (
        <MutedText>
          {t("signInChooser.using", { method: methodLabel })}
        </MutedText>
      ) : null}
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
            : t("deviceSignIn.approveBody", { name: label })}
        </p>
      </AuthorizationChallenge>
      {challenge?.kind === "local_interaction" ? (
        <Alert tone="info" title={challenge.instruction} />
      ) : null}
      {!failure && signIn?.status === "pending" && signIn.codeEntry ? (
        <CodeEntry
          format={signIn.codeEntryFormat}
          submit={(code) => io.current.submitCode(operation.current, code)}
        />
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
          {back}
        </Alert>
      ) : (
        <LoadingState
          className="text-xs leading-[1.45] text-ink-muted"
          label={signIn?.error ? t("deviceSignIn.reconnecting") : progress}
        />
      )}
    </FormLayout>
  );
}

/**
 * A sign-in whose approval page shows a code to paste back (an AWS console
 * or Claude subscription sign-in), or that ends on a local address the person
 * copies from the address bar (aliyun's OAuth, format "callback_url"): it goes
 * to the device's waiting sign-in, which the dialog's polling then sees finish.
 */
function CodeEntry({
  format,
  submit: send,
}: {
  format?: DeviceConnectorSignIn["codeEntryFormat"];
  submit: (code: string) => Promise<void>;
}) {
  const address = format === "callback_url";
  const { t } = useTranslation("externalAccounts");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await send(code.trim());
      setSent(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSending(false);
    }
  }
  if (sent) return null;
  return (
    <form
      className="fdy-xacc-code-form flex max-w-160 flex-wrap items-end gap-2"
      onSubmit={(event) => void submit(event)}
    >
      <FormField className="fdy-xacc-field flex-[1_1_260px]">
        <span>
          {t(address ? "deviceSignIn.addressLabel" : "deviceSignIn.codeLabel")}
        </span>
        <TextInput
          autoComplete="off"
          onChange={(event) => setCode(event.target.value)}
          placeholder={t(
            address
              ? "deviceSignIn.addressPlaceholder"
              : "deviceSignIn.codePlaceholder",
          )}
          spellCheck={false}
          tone="boxed"
          value={code}
        />
      </FormField>
      {error ? <Alert title={error} tone="error" /> : null}
      <Button
        aria-busy={sending}
        disabled={!code.trim() || sending}
        size="sm"
        type="submit"
        variant="primary"
      >
        {t("deviceSignIn.finish")}
      </Button>
    </form>
  );
}
