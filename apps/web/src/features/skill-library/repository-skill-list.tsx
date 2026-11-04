import { useTranslation } from "react-i18next";
import type { RepositorySkillFolder } from "@bd777/foundry-protocol";
import { Checkbox } from "../../components/ui/field";
import { RowCard } from "../../components/ui/row-card";
import { SkillNote } from "../../components/skills/skill-note";
import { RepositoryDescription } from "./repository-row";

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
        <label className="flex cursor-pointer flex-wrap items-center gap-2.5 px-2.75 text-sm">
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
          <small className="text-ink-muted">
            {t("library.repo.selectedOf", {
              count,
              total: choosable.length,
            })}
          </small>
        </label>
      ) : null}
      <ul className="grid gap-1.5">
        {folders.map((folder) => {
          const copy = (
            <span className="grid min-w-0 gap-0.5 text-sm">
              <strong>{folder.name}</strong>
              {folder.description ? (
                <RepositoryDescription as="span" title={folder.description}>
                  {folder.description}
                </RepositoryDescription>
              ) : null}
              <SkillNote>
                {[
                  folder.dir,
                  folder.license
                    ? t("library.repo.license", { license: folder.license })
                    : t("library.repo.noLicense"),
                  folder.skillId ? t("library.repo.inLibrary") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </SkillNote>
            </span>
          );
          return (
            <li key={folder.dir}>
              {chosen ? (
                <RowCard
                  as="label"
                  className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-2.75 py-2.25 has-disabled:cursor-default"
                  tone="ring"
                >
                  <Checkbox
                    aria-label={t("row.select", { name: folder.name })}
                    checked={chosen.has(folder.dir)}
                    disabled={disabled || Boolean(folder.skillId)}
                    onChange={() => onToggle?.(folder.dir)}
                  />
                  {copy}
                </RowCard>
              ) : (
                <RowCard
                  className="grid gap-0.5 px-2.75 py-2.25 text-sm"
                  tone="ring"
                >
                  {copy}
                </RowCard>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
