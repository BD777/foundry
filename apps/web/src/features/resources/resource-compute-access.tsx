import { Alert } from "../../components/ui/alert";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceInstance } from "@bd777/foundry-protocol";
import { saveDeviceResourceSettings } from "../../api";
import { Button } from "../../components/ui/button";
import { FieldHint, Checkbox, TextInput } from "../../components/ui/field";
import { useResourceAction } from "./resource-action";
import { ResourceConfirmDialog } from "./resource-confirm-dialog";
import { CheckLabel } from "../../components/ui/check-label";
import { HelpHint } from "../../components/ui/help-hint";
import { LoadingState } from "../../components/ui/loading";

/**
 * The device owner's switch for remote commands, on its compute instance:
 * whether sessions they started may lease it and run commands there.
 * Turning it off while a session holds it asks first, since that ends the
 * session's lease. Beside it, how many shared leases run at once
 * (computeSlots): automatic, or a number the owner chose.
 */
export function ResourceComputeAccess({
  instance,
  allowed,
  computeSlots = 0,
  disabled = false,
  onChanged,
}: {
  instance: ResourceInstance;
  /** What the server says now (ResourceSourceStatus.allowRemoteCommands). */
  allowed: boolean;
  /** ResourceSourceStatus.computeSlots; 0 is automatic. */
  computeSlots?: number;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("resources");
  const hintId = useId();
  const slotsId = useId();
  const slotsHintId = useId();
  const action = useResourceAction<"save" | "slots">();
  const [pending, setPending] = useState<boolean>();
  const [saved, setSaved] = useState<boolean>();
  const [applicationNote, setApplicationNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const device = instance.source.label;

  // A fresh read of the inventory is the truth again.
  useEffect(() => setSaved(undefined), [allowed]);

  const slotsText = (slots: number) => (slots > 0 ? String(slots) : "");
  const [slotsDraft, setSlotsDraft] = useState(slotsText(computeSlots));
  useEffect(() => setSlotsDraft(slotsText(computeSlots)), [computeSlots]);
  const slotsValue = slotsDraft.trim() === "" ? 0 : Number(slotsDraft);
  const slotsValid =
    Number.isInteger(slotsValue) && slotsValue >= 0 && slotsValue <= 64;
  const slotsChanged = slotsValue !== computeSlots;
  const saveSlots = () =>
    void action.run("slots", async () => {
      setApplicationNote("");
      const result = await saveDeviceResourceSettings(instance.source.id, {
        computeSlots: slotsValue,
      });
      setSlotsDraft(slotsText(result.computeSlots ?? slotsValue));
      onChanged();
      setApplicationNote(
        result.applied ? "" : t("compute.notApplied", { device }),
      );
      return "";
    });

  const save = (allow: boolean) =>
    void action.run("save", async () => {
      setPending(allow);
      setApplicationNote("");
      try {
        const result = await saveDeviceResourceSettings(instance.source.id, {
          allowRemoteCommands: allow,
        });
        setSaved(result.allowRemoteCommands);
        onChanged();
        setApplicationNote(
          result.applied ? "" : t("compute.notApplied", { device }),
        );
        return "";
      } finally {
        setPending(undefined);
      }
    });

  const checked = pending ?? saved ?? allowed;
  return (
    <div className="grid min-w-0 gap-1.5" aria-busy={Boolean(action.running)}>
      <div className="flex items-center gap-1.5">
        <CheckLabel className="fdy-res-check items-center [&>input]:mt-0">
          <Checkbox
            aria-describedby={hintId}
            checked={checked}
            disabled={disabled || Boolean(action.running)}
            onChange={(event) => {
              const allow = event.currentTarget.checked;
              if (!allow && instance.holder) setConfirming(true);
              else save(allow);
            }}
          />
          <span>{t("compute.allow")}</span>
        </CheckLabel>
        <HelpHint label={t("compute.helpLabel")}>{t("compute.help")}</HelpHint>
      </div>
      <FieldHint id={hintId}>{t("compute.hint")}</FieldHint>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (slotsChanged && slotsValid) saveSlots();
        }}
      >
        <label className="text-xs leading-normal text-ink" htmlFor={slotsId}>
          {t("compute.slots")}
        </label>
        <TextInput
          aria-describedby={slotsHintId}
          aria-invalid={!slotsValid || undefined}
          className="w-28"
          disabled={disabled || Boolean(action.running)}
          id={slotsId}
          inputMode="numeric"
          max={64}
          min={1}
          placeholder={t("compute.slotsAuto")}
          tone="boxed"
          type="number"
          value={slotsDraft}
          onChange={(event) => setSlotsDraft(event.currentTarget.value)}
        />
        {slotsChanged ? (
          <Button
            disabled={!slotsValid || disabled || Boolean(action.running)}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {t("compute.slotsSave")}
          </Button>
        ) : null}
      </form>
      <FieldHint id={slotsHintId} tone={slotsValid ? "muted" : "error"}>
        {slotsValid ? t("compute.slotsHint") : t("compute.slotsInvalid")}
      </FieldHint>
      {disabled ? (
        <FieldHint role="status">{t("reconnectingActionNote")}</FieldHint>
      ) : null}
      {action.running ? (
        <LoadingState
          className="text-xs leading-[1.6] wrap-anywhere"
          label={t("compute.saving")}
        />
      ) : null}
      {applicationNote ? (
        <Alert size="compact" title={applicationNote} />
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
