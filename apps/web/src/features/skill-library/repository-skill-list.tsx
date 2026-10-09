import { useTranslation } from "react-i18next";
import type { RepositorySkillFolder } from "@bd777/foundry-protocol";
import { Checkbox } from "../../components/ui/field";

/**
 * The skill folders of a repository: to choose from (with checkboxes) or,
 * for a bundle, to see what it brings.
 */
export function RepositorySkillList({
  folders,
  chosen,
  disabled,
  onToggle,
  onChooseAll,
}: {
  folders: RepositorySkillFolder[];
  /** Absent: a read-only list. */
  chosen?: Set<string>;
  disabled?: boolean;
  onToggle?: (dir: string) => void;
  /** Replaces the choice; with it, the list offers select all / clear. */
  onChooseAll?: (dirs: string[]) => void;
}) {
  const { t } = useTranslation("skills");
  // Folders already in the library cannot be chosen again.
  const choosable = folders
    .filter((folder) => !folder.skillId)
    .map((folder) => folder.dir);
  const count = choosable.filter((dir) => chosen?.has(dir)).length;
  const all = choosable.length > 0 && count === choosable.length;
  return (
    <>
      {chosen && onChooseAll && choosable.length > 1 ? (
        <label className="fdy-skill-repo-select-all">
          <Checkbox
            checked={all}
            disabled={disabled}
            onChange={() => onChooseAll(all ? [] : choosable)}
            ref={(element) => {
              if (element) element.indeterminate = count > 0 && !all;
            }}
          />
          <span>
            {all ? t("library.repo.clearAll") : t("library.repo.selectAll")}
          </span>
          <small>
            {t("library.repo.selectedOf", {
              count,
              total: choosable.length,
            })}
          </small>
        </label>
      ) : null}
      <ul className="fdy-skill-repo-choices">
        {folders.map((folder) => {
          const copy = (
            <span>
              <strong>{folder.name}</strong>
              {folder.description ? (
                <span
                  className="fdy-skill-repo-description"
                  title={folder.description}
                >
                  {folder.description}
                </span>
              ) : null}
              <small>
                {[
                  folder.dir,
                  folder.license
                    ? t("library.repo.license", { license: folder.license })
                    : t("library.repo.noLicense"),
                  folder.skillId ? t("library.repo.inLibrary") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
          );
          return (
            <li key={folder.dir}>
              {chosen ? (
                <label>
                  <Checkbox
                    aria-label={t("row.select", { name: folder.name })}
                    checked={chosen.has(folder.dir)}
                    disabled={disabled || Boolean(folder.skillId)}
                    onChange={() => onToggle?.(folder.dir)}
                  />
                  {copy}
                </label>
              ) : (
                <div className="fdy-skill-repo-choice-static">{copy}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
