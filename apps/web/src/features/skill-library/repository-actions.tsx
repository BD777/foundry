import { useTranslation } from "react-i18next";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";

export type RepositoryMenuItem = Omit<RowMenuItem, "confirm">;

/**
 * A repository card's secondary actions behind one "…" button, so the card's
 * text keeps its width. Stopping to follow is last and asks first, saying
 * what happens to the skills.
 */
export function RepositoryActions({
  label,
  items,
  disabled,
  unfollowCopy,
  onUnfollow,
}: {
  /** The repository as people see it, for the menu's name and the dialog. */
  label: string;
  items: RepositoryMenuItem[];
  disabled: boolean;
  /** What stopping does to this repository's skills. */
  unfollowCopy: string;
  onUnfollow: () => void;
}) {
  const { t } = useTranslation("skills");
  return (
    <RowMenu
      disabled={disabled}
      items={[
        ...items,
        {
          key: "unfollow",
          tone: "danger" as const,
          label: t("library.repo.remove"),
          onSelect: onUnfollow,
          confirm: {
            title: t("library.repo.removeTitle", { label }),
            body: unfollowCopy,
            action: t("library.repo.remove"),
          },
        },
      ]}
      label={t("library.repo.actionsFor", { label })}
    />
  );
}
