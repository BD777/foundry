import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";

/**
 * Marks a skill or bundle the workspace gets without selecting it: one of
 * its owner's defaults. Unchecked here, it says the default is off in this
 * workspace instead of still claiming it is on.
 */
export function DefaultSkillBadge({
  show,
  off = false,
}: {
  show: boolean;
  /** The default is turned off in this workspace. */
  off?: boolean;
}) {
  const { t } = useTranslation("skills");
  if (!show) return null;
  return (
    <Badge title={t("workspace.fromDefaultsTitle")} tone="neutral">
      {off ? t("workspace.fromDefaultsOff") : t("workspace.fromDefaults")}
    </Badge>
  );
}

/** Marks a skill the workspace gets from a bundle it uses. */
export function ViaBundleBadge({ name }: { name?: string }) {
  const { t } = useTranslation("skills");
  if (!name) return null;
  return (
    <Badge title={t("workspace.viaBundleTitle", { name })} tone="neutral">
      {t("workspace.viaBundle", { name })}
    </Badge>
  );
}
