import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";

/**
 * A device a chat's setup panel sent the person to
 * (navigateToConnectorSetup): its row comes into view, marked, with its
 * next-step button focused. Nothing starts until the person clicks it; a
 * link alone never acts on a device.
 */
export function useSetupTarget<T extends HTMLElement>(
  targeted: boolean,
  /** Changes when the row's next step does (its reading arrived). */
  step = "",
) {
  const ref = useRef<T>(null);
  const shown = useRef(false);
  useEffect(() => {
    const row = ref.current;
    if (!targeted || !row) return;
    if (!shown.current) row.scrollIntoView?.({ block: "center" });
    // Moves with the next step, never away from where the person went.
    const active = document.activeElement;
    if (
      shown.current &&
      active &&
      active !== document.body &&
      !row.contains(active)
    )
      return;
    shown.current = true;
    row
      .querySelector<HTMLButtonElement>(
        "[data-row-actions] button:not(:disabled)",
      )
      ?.focus({ preventScroll: true });
  }, [targeted, step]);
  return ref;
}

/** How a targeted row stands out (data-setup-target on the row). */
export const setupTargetClass =
  "data-[setup-target=true]:rounded-lg data-[setup-target=true]:bg-accent-soft";

/** The one line on a targeted row. */
export function SetupTargetHint() {
  const { t } = useTranslation("externalAccounts");
  return (
    <span className="font-[650] text-brand-dark">
      {t("deviceHeld.setupTarget")}
    </span>
  );
}
