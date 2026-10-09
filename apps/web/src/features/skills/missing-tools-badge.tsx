import { useTranslation } from "react-i18next";
import type { DeviceTool } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";

/**
 * Warns that the workspace's device lacks a program a skill runs, as the
 * device reported at its last skill scan. Programs it has not reported on
 * are not flagged.
 */
export function MissingToolsBadge({
  requires,
  deviceTools,
  deviceLabel,
}: {
  requires?: string[];
  /** The workspace device's reports. */
  deviceTools?: DeviceTool[];
  deviceLabel?: string;
}) {
  const { t } = useTranslation("skills");
  const missing = (requires ?? []).filter((tool) =>
    deviceTools?.some((row) => row.tool === tool && !row.available),
  );
  if (!missing.length) return null;
  return (
    <Badge
      title={t("workspace.missingToolsTitle", { tools: missing.join(", ") })}
      tone="warn"
    >
      {t("workspace.missingTools", {
        device: deviceLabel ?? "",
        tools: missing.join(", "),
      })}
    </Badge>
  );
}
