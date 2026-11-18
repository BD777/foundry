import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OctagonX } from "lucide-react";
import { Button, type ButtonProps } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";

/**
 * 「停止助理工作」 behind a confirmation. Stopping cancels the helpers running
 * right now and only 「继续」 takes it back, so one stray click must not stop
 * them. `helperCount` is the helpers the page already lists; the dialog names
 * it only when some are running.
 */
export function StopAssistantButton({
  busy,
  helperCount = 0,
  onStop,
  size,
}: {
  busy: boolean;
  helperCount?: number;
  /** Called once, after the person confirms; the caller runs the request and shows its errors. */
  onStop: () => void;
  size?: ButtonProps["size"];
}) {
  const { t } = useTranslation(["personalAgent", "common"]);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        aria-busy={busy}
        disabled={busy}
        onClick={() => setConfirming(true)}
        size={size}
        variant="secondary"
      >
        <OctagonX aria-hidden="true" size={size === "sm" ? 14 : 15} />
        {busy ? t("home.stopping") : t("home.stopAll")}
      </Button>
      {confirming ? (
        <Dialog
          description={
            helperCount > 0
              ? t("home.stopConfirm.bodyWithCount", { count: helperCount })
              : t("home.stopConfirm.body")
          }
          footer={
            <div className="ml-auto flex justify-end gap-2">
              <Button
                ref={cancelRef}
                onClick={() => setConfirming(false)}
                variant="ghost"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                  onStop();
                }}
                variant="danger"
              >
                {t("home.stopConfirm.confirm")}
              </Button>
            </div>
          }
          initialFocus={cancelRef}
          layout="compact"
          onClose={() => setConfirming(false)}
          title={t("home.stopConfirm.title")}
        />
      ) : null}
    </>
  );
}
