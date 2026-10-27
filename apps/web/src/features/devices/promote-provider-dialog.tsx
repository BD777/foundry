import { ToastFeedback } from "../../components/ui/toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { promoteProfile } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, Checkbox } from "../../components/ui/field";
import { runtimeMeta } from "../../components/ui/runtime-mark";
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
      <div className="fdy-provider-promotion" aria-busy={busy}>
        <section>
          <h3>{t("promotion.copied")}</h3>
          <dl className="fdy-provider-promotion-fields">
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
        <section>
          <h3>{t("promotion.key")}</h3>
          {row.keySource ? (
            <>
              <label className="fdy-provider-promotion-key">
                <Checkbox
                  checked={copyKey}
                  disabled={busy || !online}
                  onChange={(event) => setCopyKey(event.target.checked)}
                />
                <span>
                  <strong>
                    {t("promotion.copyKey", { source: row.keySource })}
                  </strong>
                  <FieldHint as="small">
                    {t("promotion.copyKeyHint", { device: device.label })}
                  </FieldHint>
                </span>
              </label>
              {!online ? (
                <p role="status">
                  {t("promotion.keyOffline", { device: device.label })}
                </p>
              ) : null}
              {promoted?.hasCredential && !copyKey ? (
                <p>{t("promotion.keyKept")}</p>
              ) : null}
            </>
          ) : (
            <p>{t("promotion.noKey")}</p>
          )}
        </section>
        <section>
          <h3>{t("promotion.devices")}</h3>
          <p>
            {loopback
              ? t("promotion.loopback", {
                  address: loopback,
                  device: device.label,
                })
              : t("promotion.shareable", { device: device.label })}
          </p>
        </section>
        {error ? <ToastFeedback tone="error" title={error} /> : null}
      </div>
    </Dialog>
  );
}
