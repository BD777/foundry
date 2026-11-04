import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

/**
 * Reachable destination shown under the chat/issue agent picker when at least
 * one agent row is unavailable: the row explains why, this action opens the
 * existing Devices → device → Agents page. Presentational only; the feature
 * owns navigation, so shared UI stays dependency-free.
 */
export function AgentPickerFooter({
  deviceId,
  onManage,
}: {
  deviceId?: string;
  onManage?: (deviceId: string) => void;
}) {
  const { t } = useTranslation("agents");
  if (!deviceId || !onManage) {
    return null;
  }
  return (
    <Button
      className="h-7.5 w-auto justify-start gap-1.5 px-2 text-xs font-[650] text-ink-muted hover:text-brand hover:underline"
      onClick={() => onManage(deviceId)}
      size="sm"
      variant="ghost"
    >
      <Settings2 size={13} />
      {t("composer.manageDeviceAccounts")}
    </Button>
  );
}
