import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorSignIn,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  beginDeviceConnectorSignIn,
  dismissDeviceConnectorSignIn,
  pollDeviceConnectorSignIn,
  submitDeviceConnectorSignInCode,
} from "../../api";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { TextInput } from "../../components/ui/field";
import { Spinner } from "../../components/ui/loading";
import { errorText } from "./account-format";

type Method = "console" | "sso";

interface Run {
  phase: "starting" | "waiting" | "submitting" | "checking" | "failed";
  signIn?: DeviceConnectorSignIn;
  error?: string;
}

const pollEveryMs = 3_000;

/** Only an https page without credentials in it becomes a link. */
function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * AWS sign-in from the browser, run on the device (worker aws-sign-in.ts):
 * "Open AWS sign-in" starts `aws login` there and opens AWS's sign-in page
 * here; the person signs in with their console session and pastes back the
 * code AWS shows. With IAM Identity Center the page asks for the portal's
 * details instead, and the person confirms a code on AWS's page; nothing
 * comes back. Either way the login is written on the device, never here,
 * and the row turns ready once the device reads it.
 */
export function AwsBrowserSignIn({
  connector,
  device,
  onState,
}: {
  connector: ConnectorDescriptor;
  device: DeviceConnectorDevice;
  onState: (state: DeviceConnectorState) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const methods = (connector.browserSignIn ?? []) as Method[];
  const [method, setMethod] = useState<Method>(
    methods.includes("console") ? "console" : "sso",
  );
  const [fields, setFields] = useState({
    region: "us-east-1",
    startUrl: "",
    ssoRegion: "",
    accountId: "",
    roleName: "",
  });
  // The Region is only the CLI's default for commands that name none; the
  // login itself covers every Region the account allows. It stays folded.
  const [editRegion, setEditRegion] = useState(false);
  const [code, setCode] = useState("");
  const [run, setRun] = useState<Run>();
  const operation = useRef("");
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(true);
  const done = useRef(onState);
  done.current = onState;
  const values = { device: device.name, name: connector.label };

  const dismiss = () => {
    window.clearTimeout(timer.current);
    const id = operation.current;
    operation.current = "";
    if (id)
      void dismissDeviceConnectorSignIn(
        device.deviceId,
        connector.kind,
        id,
      ).catch(() => {});
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      queueMicrotask(() => {
        if (!live.current) dismiss();
      });
    };
  }, []);

  // Handles one answer; true while the sign-in still waits.
  const settle = (next: DeviceConnectorSignIn, popup?: Window | null) => {
    if (!live.current) return false;
    if (next.operationId) operation.current = next.operationId;
    const link = safeLink(next.verificationUrl);
    if (popup && !popup.closed && link) popup.location.href = link;
    if (next.status === "complete") {
      operation.current = "";
      if (next.state?.signedIn) {
        setRun(undefined);
        done.current(next.state);
      } else
        setRun({
          phase: "failed",
          error: t("browserSignIn.unverified", values),
        });
      return false;
    }
    if (next.status !== "pending") {
      operation.current = "";
      setRun({
        phase: "failed",
        error:
          next.error ||
          t(
            next.status === "expired"
              ? "browserSignIn.expired"
              : next.status === "denied"
                ? "browserSignIn.denied"
                : "browserSignIn.failedUnknown",
          ),
      });
      return false;
    }
    setRun((current) => ({
      phase:
        current?.phase === "submitting" || current?.phase === "checking"
          ? "checking"
          : next.verificationUrl
            ? "waiting"
            : "starting",
      signIn: { ...current?.signIn, ...next },
    }));
    return true;
  };

  const poll = (popup?: Window | null) => {
    timer.current = window.setTimeout(async () => {
      if (!live.current || !operation.current) return;
      try {
        const next = await pollDeviceConnectorSignIn(
          device.deviceId,
          connector.kind,
          operation.current,
        );
        if (settle(next, popup)) poll(popup);
      } catch (cause) {
        if (live.current) setRun({ phase: "failed", error: errorText(cause) });
      }
    }, pollEveryMs);
  };

  async function start(event: FormEvent) {
    event.preventDefault();
    dismiss();
    setCode("");
    // Opened now, while the click still allows it; it goes to AWS's page
    // once the device has it.
    const popup =
      method === "console" ? window.open("about:blank", "_blank") : null;
    if (popup) {
      popup.opener = null;
      popup.document.title = t("browserSignIn.popupTitle");
      popup.document.body.textContent = t("browserSignIn.popupBody", values);
    }
    setRun({ phase: "starting" });
    const options: Record<string, string> =
      method === "console"
        ? { method, region: fields.region.trim() }
        : {
            method,
            region: fields.region.trim(),
            startUrl: fields.startUrl.trim(),
            ssoRegion: fields.ssoRegion.trim() || fields.region.trim(),
            accountId: fields.accountId.trim(),
            roleName: fields.roleName.trim(),
          };
    try {
      const started = await beginDeviceConnectorSignIn(
        device.deviceId,
        connector.kind,
        crypto.randomUUID(),
        undefined,
        options,
      );
      if (settle(started, popup)) poll(popup);
      else popup?.close();
    } catch (cause) {
      popup?.close();
      if (live.current) setRun({ phase: "failed", error: errorText(cause) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || !operation.current) return;
    setRun((current) => current && { ...current, phase: "submitting" });
    try {
      await submitDeviceConnectorSignInCode(
        device.deviceId,
        connector.kind,
        operation.current,
        code,
      );
      if (live.current)
        setRun((current) => current && { ...current, phase: "checking" });
    } catch (cause) {
      if (live.current) setRun({ phase: "failed", error: errorText(cause) });
    }
  }

  const field = (
    key: keyof typeof fields,
    label: string,
    props: {
      placeholder?: string;
      inputMode?: "numeric";
      required?: boolean;
    } = {},
  ) => (
    <label className="fdy-xacc-field">
      <span>{label}</span>
      <TextInput
        autoComplete="off"
        onChange={(event) =>
          setFields({ ...fields, [key]: event.target.value })
        }
        spellCheck={false}
        tone="boxed"
        value={fields[key]}
        {...props}
      />
    </label>
  );

  const link = safeLink(run?.signIn?.verificationUrl);
  if (run && run.phase !== "failed")
    return (
      <div className="fdy-xacc-browser-sign-in" aria-live="polite">
        {link ? (
          <>
            <p>
              {run.signIn?.codeEntry
                ? t("browserSignIn.consoleSteps", values)
                : t("browserSignIn.ssoSteps", values)}
            </p>
            <span className="fdy-xacc-form-actions">
              <Button asChild size="sm" variant="primary">
                <a href={link} rel="noopener noreferrer" target="_blank">
                  <ExternalLink aria-hidden="true" size={14} />
                  {t("browserSignIn.openPage")}
                </a>
              </Button>
              <CopyButton
                copiedLabel={t("browserSignIn.linkCopied")}
                label={t("browserSignIn.copyLink")}
                text={link}
              />
            </span>
            {run.signIn?.userCode ? (
              <span className="fdy-xacc-user-code">
                <span>{t("browserSignIn.userCode")}</span>
                <code>{run.signIn.userCode}</code>
                <CopyButton
                  copiedLabel={t("browserSignIn.codeCopied")}
                  label={t("browserSignIn.copyCode", {
                    code: run.signIn.userCode,
                  })}
                  text={run.signIn.userCode}
                />
              </span>
            ) : null}
            {run.signIn?.codeEntry && run.phase === "waiting" ? (
              <form
                className="fdy-xacc-code-form"
                onSubmit={(e) => void submit(e)}
              >
                <label className="fdy-xacc-field">
                  <span>{t("browserSignIn.codeLabel")}</span>
                  <TextInput
                    autoComplete="off"
                    onChange={(event) => setCode(event.target.value)}
                    placeholder={t("browserSignIn.codePlaceholder")}
                    spellCheck={false}
                    tone="boxed"
                    value={code}
                  />
                </label>
                <Button
                  disabled={!code.trim()}
                  size="sm"
                  type="submit"
                  variant="primary"
                >
                  {t("browserSignIn.finish")}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
        <p className="fdy-xacc-sign-in-status" role="status">
          <Spinner />
          {run.phase === "starting"
            ? t("browserSignIn.starting", values)
            : run.phase === "waiting" && !run.signIn?.codeEntry
              ? t("browserSignIn.waiting")
              : run.phase === "waiting"
                ? t("browserSignIn.waitingCode")
                : t("browserSignIn.checking", values)}
        </p>
        <span className="fdy-xacc-form-actions">
          <Button
            onClick={() => {
              dismiss();
              setRun(undefined);
            }}
            size="sm"
            variant="ghost"
          >
            {t("browserSignIn.cancel")}
          </Button>
        </span>
      </div>
    );

  return (
    <form className="fdy-xacc-browser-sign-in" onSubmit={(e) => void start(e)}>
      {run?.phase === "failed" ? (
        <p className="fdy-xacc-sign-in-error" role="alert">
          {t("browserSignIn.failed", { error: run.error ?? "" })}
        </p>
      ) : null}
      <p>
        {method === "console"
          ? t("browserSignIn.consoleIntro", values)
          : t("browserSignIn.ssoIntro", values)}
      </p>
      {device.online ? null : (
        <p className="fdy-xacc-sign-in-offline">
          {t("browserSignIn.offline", values)}
        </p>
      )}
      <div className="fdy-xacc-sign-in-fields">
        {method === "sso" ? (
          <>
            {field("startUrl", t("browserSignIn.startUrl"), {
              placeholder: "https://my-company.awsapps.com/start",
              required: true,
            })}
            {field("accountId", t("browserSignIn.accountId"), {
              inputMode: "numeric",
              placeholder: "123456789012",
              required: true,
            })}
            {field("roleName", t("browserSignIn.roleName"), {
              placeholder: t("browserSignIn.rolePlaceholder"),
              required: true,
            })}
            {field("ssoRegion", t("browserSignIn.ssoRegion"), {
              placeholder: fields.region || "us-east-1",
            })}
          </>
        ) : null}
        {editRegion
          ? field("region", t("browserSignIn.region"), {
              placeholder: "us-east-1",
              required: true,
            })
          : null}
      </div>
      {editRegion ? null : (
        <p className="fdy-xacc-sign-in-region">
          {t("browserSignIn.regionSummary", {
            region: fields.region.trim() || "us-east-1",
          })}{" "}
          <Button
            onClick={() => setEditRegion(true)}
            size="inline"
            variant="link"
          >
            {t("browserSignIn.changeRegion")}
          </Button>
        </p>
      )}
      <span className="fdy-xacc-form-actions">
        <Button
          disabled={!device.online}
          size="sm"
          type="submit"
          variant="primary"
        >
          {run?.phase === "failed"
            ? t("browserSignIn.retry")
            : method === "console"
              ? t("browserSignIn.openConsole")
              : t("browserSignIn.getCode")}
        </Button>
        {methods.length > 1 ? (
          <Button
            onClick={() => setMethod(method === "console" ? "sso" : "console")}
            size="sm"
            variant="ghost"
          >
            {method === "console"
              ? t("browserSignIn.useSso")
              : t("browserSignIn.useConsole")}
          </Button>
        ) : null}
      </span>
    </form>
  );
}
