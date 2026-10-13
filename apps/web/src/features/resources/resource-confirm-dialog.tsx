import { useTranslation } from "react-i18next";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";
import { Button } from "../../components/ui/button";

/**
 * Asks before an action on a resource, listing what it does. A destructive
 * one (Release, Stop all) says so in its confirm button.
 */
export function ResourceConfirmDialog({
  title,
  description,
  items,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  items: string[];
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("resources");
  return (
    <WorkspaceDialog title={title} description={description} onClose={onClose}>
      <ul className="fdy-res-confirm-items">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <footer className="fdy-res-confirm-actions">
        <Button variant="secondary" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          className={destructive ? "fdy-res-danger" : undefined}
          variant="primary"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </footer>
    </WorkspaceDialog>
  );
}
