import { useTranslation } from "react-i18next";
import { Dialog } from "../ui/dialog";
import { LoadingState } from "../ui/loading";

/**
 * The compare dialog while its code loads: the same window, title and size,
 * with the wait inside its body, so the dialog does not appear twice.
 */
export function SkillCompareLoading({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("skills");
  return (
    <Dialog
      layout="compact"
      onClose={onClose}
      size="large"
      title={t("compare.title", { name })}
    >
      <LoadingState label={t("device.loadingComparison")} layout="block" />
    </Dialog>
  );
}
