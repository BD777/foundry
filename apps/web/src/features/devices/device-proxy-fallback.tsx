import type { DeviceProjection } from "@bd777/foundry-protocol";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { setDeviceWorkerProxy } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, TextInput } from "../../components/ui/field";
import { FormField } from "../../components/ui/form-field";
import { ToastFeedback } from "../../components/ui/toast";
import { deviceConnection } from "../../lib/device-connection";
import { time } from "./device-diagnostics-text";

/**
 * Whether an address is one the Worker takes: http, https, socks5 or
 * socks5h, a host, optional user:password@, a port, nothing after it. The
 * Worker checks again (server-proxy.ts validateProxyURL).
 */
export function validProxyAddress(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (
      ["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * The worker reaches the server around its configured proxy, which kept
 * failing (DEV-217); it goes back to the proxy by itself once it works.
 * Shown on every section of the device's page, with the two ways out its
 * owner has: stop using the proxy, or use another one.
 */
export function ProxyFallbackNote({
  device,
  onRefresh,
}: {
  device: DeviceProjection;
  onRefresh?: () => Promise<void>;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const fallback = device.worker?.proxyFallback;
  if (!device.owned || !fallback || deviceConnection(device) !== "online")
    return null;
  const change = async (next: { clear: true } | { url: string }) => {
    setBusy(true);
    setError("");
    setDone("");
    try {
      await setDeviceWorkerProxy(device.id, next);
      setDone(t("worker.proxyChanged"));
      setEditing(false);
      await onRefresh?.().catch(() => {});
      return true;
    } catch (cause) {
      const message = t("worker.proxyChangeFailed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      if ("url" in next) throw new Error(message);
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert
      tone="warning"
      title={t(
        fallback.route === "direct"
          ? "worker.proxyFallbackDirect"
          : "worker.proxyFallbackEnvironment",
        {
          proxy: fallback.configured,
          environmentProxy: fallback.environmentProxy ?? "",
        },
      )}
    >
      <p>
        {t("worker.proxyFallbackBody", {
          since: time(fallback.since),
          proxy: fallback.configured,
        })}
      </p>
      <ButtonRow className="mt-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void change({ clear: true })}
        >
          {t("worker.proxyStopUsing")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError("");
            setDone("");
            setEditing(true);
          }}
        >
          {t("worker.proxyUseAnother")}
        </Button>
      </ButtonRow>
      {done ? <ToastFeedback tone="success" title={done} /> : null}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
      <ProxyAddressDialog
        open={editing}
        onClose={() => setEditing(false)}
        onSave={async (url) => {
          await change({ url });
        }}
      />
    </Alert>
  );
}

function ProxyAddressDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (url: string) => Promise<void>;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const valid = validProxyAddress(draft);
  const save = async () => {
    if (saving) return;
    if (!valid) {
      setError(t("worker.proxyAddressInvalid"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(draft.trim());
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t("worker.proxyUseAnotherTitle")}
      description={t("worker.proxyUseAnotherDescription")}
      open={open}
      onClose={onClose}
      busy={saving}
      layout="compact"
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={saving || !draft.trim()}
            onClick={() => void save()}
          >
            {saving ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
        </>
      }
    >
      <FormField>
        <span>{t("worker.proxyAddress")}</span>
        <TextInput
          ref={inputRef}
          tone="boxed"
          value={draft}
          placeholder={t("worker.proxyAddressPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          maxLength={2048}
          disabled={saving}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : hintId}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </FormField>
      {error ? (
        <FieldHint id={errorId} tone="error">
          {error}
        </FieldHint>
      ) : (
        <FieldHint id={hintId}>{t("worker.proxyAddressHint")}</FieldHint>
      )}
    </Dialog>
  );
}
