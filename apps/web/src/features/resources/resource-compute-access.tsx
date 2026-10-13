import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { saveDeviceResourceSettings } from "../../api";
import { Checkbox } from "../../components/ui/field";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";

/**
 * The device owner's switch for remote commands, on its compute instance:
 * whether sessions they started may lease it and run commands there.
 * Turning it off while a session holds it asks first, since that ends the
 * session's lease.
 */
export function ResourceComputeAccess({
  instance,
  allowed,
  onChanged,
}: {
  instance: ResourceInstance;
  /** What the server says now (ResourceSourceStatus.allowRemoteCommands). */
  allowed: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const hintId = useId();
  const action = useResourceAction<"save">();
  const [pending, setPending] = useState<boolean>();
  const [saved, setSaved] = useState<boolean>();
  const [confirming, setConfirming] = useState(false);
  const device = instance.source.label;

  // A fresh read of the inventory is the truth again.
  useEffect(() => setSaved(undefined), [allowed]);

  const save = (allow: boolean) =>
    void action.run("save", async () => {
      setPending(allow);
      try {
        const result = await saveDeviceResourceSettings(instance.source.id, {
          allowRemoteCommands: allow,
        });
        setSaved(result.allowRemoteCommands);
        onChanged();
        return result.applied ? "" : t("compute.notApplied", { device });
      } finally {
        setPending(undefined);
      }
    });

  const checked = pending ?? saved ?? allowed;
  return (
    <div className="fdy-res-compute-access" aria-busy={Boolean(action.running)}>
      <label className="fdy-res-check">
        <Checkbox
          aria-describedby={hintId}
          checked={checked}
          disabled={Boolean(action.running)}
          onChange={(event) => {
            const allow = event.currentTarget.checked;
            if (!allow && instance.holder) setConfirming(true);
            else save(allow);
          }}
        />
        <span>{t("compute.allow")}</span>
      </label>
      <p className="fdy-res-meta" id={hintId}>
        {t("compute.hint")}
      </p>
      {action.running ? (
        <p className="fdy-res-status" role="status">
          {t("compute.saving")}
        </p>
      ) : null}
      {action.notice ? (
        <p className="fdy-res-note" role="status">
          {action.notice}
        </p>
      ) : null}
      {action.error ? (
        <p className="fdy-res-error" role="alert">
          {action.error}
        </p>
      ) : null}
      {confirming ? (
        <ResourceConfirmDialog
          confirmLabel={t("compute.offConfirm")}
          description={t("compute.offDescription")}
          destructive
          items={[t("compute.offItems.ends"), t("compute.offItems.later")]}
          title={t("compute.offTitle", { device })}
          onClose={() => setConfirming(false)}
          onConfirm={() => save(false)}
        />
      ) : null}
    </div>
  );
}
