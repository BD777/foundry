import { Settings2 } from "lucide-react";
import { Button } from "./button";

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
  if (!deviceId || !onManage) {
    return null;
  }
  return (
    <Button
      className="fdy-select-footer-link"
      onClick={() => onManage(deviceId)}
      size="sm"
      variant="ghost"
    >
      <Settings2 size={13} />
      Manage device accounts…
    </Button>
  );
}
