import { useTranslation } from "react-i18next";
import { ToastFeedback } from "../../components/ui/toast";

export function SkillSelectionFeedback({
  autoEnabledNames,
  duplicateNames,
  readOnlyReason,
}: {
  autoEnabledNames: string[];
  duplicateNames: string[];
  readOnlyReason?: string;
}) {
  const { t } = useTranslation("skills");
  return (
    <>
      {autoEnabledNames.length > 0 ? (
        <p role="status">
          {t("workspace.autoEnabled", {
            names: autoEnabledNames.join(", "),
          })}
        </p>
      ) : null}
      {duplicateNames.length ? (
        <ToastFeedback
          tone="error"
          title={t("workspace.duplicateNames", {
            names: duplicateNames.join(", "),
          })}
        />
      ) : null}
      {readOnlyReason ? <p role="note">{readOnlyReason}</p> : null}
    </>
  );
}
