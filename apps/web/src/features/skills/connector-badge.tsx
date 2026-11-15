import { useTranslation } from "react-i18next";
import type { ConnectorSkillGroup } from "../../api-types";
import { Badge } from "../../components/ui/badge";

/** Each connector skill's connector name, by skill id. */
export function connectorLabels(
  groups: ConnectorSkillGroup[] | undefined,
): Map<string, string> {
  return new Map(
    (groups ?? []).flatMap((group) =>
      group.skillIds.map((id) => [id, group.label] as const),
    ),
  );
}

/**
 * Marks a skill the workspace gets from a connector granted to it.
 * Unchecked here, it says the skill is off in this workspace.
 */
export function FromConnectorBadge({
  name,
  off = false,
}: {
  name?: string;
  /** The workspace turned the skill off. */
  off?: boolean;
}) {
  const { t } = useTranslation("skills");
  if (!name) return null;
  return (
    <Badge title={t("workspace.fromConnectorTitle", { name })} tone="neutral">
      {off
        ? t("workspace.fromConnectorOff", { name })
        : t("workspace.fromConnector", { name })}
    </Badge>
  );
}
