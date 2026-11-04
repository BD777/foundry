import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { promoteProfile } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, Checkbox } from "../../components/ui/field";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { loopbackHost } from "../../lib/model-connections";

/**
 * Confirms promoting one API provider from the device's own configuration
 * into a Model provider, saying exactly what is copied. The key is copied
 * only when the person ticks it here, and only the one the provider's
 * configuration names.
 */
export function PromoteProviderDialog({
  device,
  row,
  promoted,
  onClose,
  onPromoted,
}: {
  device: DeviceProjection;
  row: AgentProfileProjection;
  /** The Model provider it was promoted to before: promoting updates it. */
  promoted?: ProfileDefinition;
  onClose: () => void;
  onPromoted: (profile: ProfileDefinition) => Promise<void>;
}) {
  const { t } = useTranslation(["profiles", "common"]);
  const [copyKey, setCopyKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const online = device.status === "connected";
  const loopback = loopbackHost(row.baseUrl);
  const models = row.models?.length ? row.models.join(", ") : "";
  const promote = async () => {
    setBusy(true);
    setError("");
    try {
      const profile = await promoteProfile({
        deviceId: device.id,
        profileId: row.id,
        copyKey: copyKey || undefined,
      });
      await onPromoted(profile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("promotion.failed"));
      setBusy(false);
    }
  };
  return (
    <Dialog
      busy={busy}
      description={t(
        promoted ? "promotion.updateDescription" : "promotion.description",
        { device: device.label, source: row.configLabel },
      )}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">
            {t("common:actions.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void promote()}
            variant="primary"
          >
            {busy
              ? t("promotion.promoting")
              : promoted
                ? t("promotion.update")
                : t("promotion.promote")}
          </Button>
        </>
      }
      layout="compact"
      onClose={onClose}
      title={t(promoted ? "promotion.updateTitle" : "promotion.title", {
        name: row.label,
      })}
    >
      <div
        className="grid min-w-0 content-start gap-4.5 text-sm"
        aria-busy={busy}
      >
        <section className="grid min-w-0 gap-2">
          <h3 className="text-sm text-ink">{t("promotion.copied")}</h3>
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 [&>dd]:wrap-anywhere [&>dd]:text-ink [&>dt]:text-ink-muted">
            <dt>{t("promotion.name")}</dt>
            <dd>{row.label}</dd>
            <dt>{t("promotion.agent")}</dt>
            <dd>{runtimeMeta(row.runtime).productName}</dd>
            <dt>{t("promotion.baseUrl")}</dt>
            <dd>
              <code>{row.baseUrl}</code>
            </dd>
            <dt>{t("promotion.api")}</dt>
            <dd>
              {row.runtime === "claude"
                ? t("promotion.claudeApi")
                : t("promotion.codexApi")}
            </dd>
            <dt>{t("promotion.defaultModel")}</dt>
            <dd>{row.model || t("promotion.agentDefault")}</dd>
            {models ? (
              <>
                <dt>{t("promotion.models")}</dt>
                <dd>{models}</dd>
              </>
            ) : null}
          </dl>
        </section>
        <section className="grid min-w-0 gap-2">
          <h3 className="text-sm text-ink">{t("promotion.key")}</h3>
          {row.keySource ? (
            <>
              <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-lg px-3.25 py-2.75 shadow-hairline">
                <Checkbox
                  checked={copyKey}
                  disabled={busy || !online}
                  onChange={(event) => setCopyKey(event.target.checked)}
                />
                <span className="grid min-w-0 gap-1">
                  <strong className="wrap-anywhere">
                    {t("promotion.copyKey", { source: row.keySource })}
                  </strong>
                  <FieldHint as="small" className="leading-[1.5]">
                    {t("promotion.copyKeyHint", { device: device.label })}
                  </FieldHint>
                </span>
              </label>
              {!online ? (
                <Alert
                  tone="warning"
                  size="compact"
                  title={t("promotion.keyOffline", { device: device.label })}
                />
              ) : null}
              {promoted?.hasCredential && !copyKey ? (
                <FieldHint>{t("promotion.keyKept")}</FieldHint>
              ) : null}
            </>
          ) : (
            <Alert size="compact" title={t("promotion.noKey")} />
          )}
        </section>
        <section className="grid min-w-0 gap-2">
          <h3 className="text-sm text-ink">{t("promotion.devices")}</h3>
          <Alert
            size="compact"
            tone={loopback ? "warning" : "info"}
            title={
              loopback
                ? t("promotion.loopback", {
                    address: loopback,
                    device: device.label,
                  })
                : t("promotion.shareable", { device: device.label })
            }
          />
        </section>
        {error ? <ToastFeedback tone="error" title={error} /> : null}
      </div>
    </Dialog>
  );
}
