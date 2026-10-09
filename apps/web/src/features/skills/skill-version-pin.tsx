import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PromotedSkill,
  WorkspaceSkillBinding,
} from "@bd777/foundry-protocol";
import { setWorkspaceSkillPin } from "../../api";
import { SelectMenu } from "../../components/ui/select-menu";

/**
 * Which revision of a selected skill this workspace runs: the latest, or one
 * it is held at while the library moves on.
 */
export function SkillVersionPin({
  skill,
  binding,
  workspaceId,
  readOnly,
  onChanged,
}: {
  skill: PromotedSkill;
  /** Absent until the selection is saved. */
  binding?: WorkspaceSkillBinding;
  workspaceId: string;
  readOnly: boolean;
  onChanged?: () => Promise<void>;
}) {
  const { t } = useTranslation("skills");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!binding) return null;
  const revisions = Array.from(
    { length: skill.latestRevision },
    (_, index) => skill.latestRevision - index,
  );
  const change = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await setWorkspaceSkillPin(workspaceId, skill.id, Number(value));
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SelectMenu
        ariaLabel={t("workspace.versionFor", { name: skill.name })}
        disabled={readOnly || busy}
        onChange={(value) => void change(value)}
        options={[
          {
            value: "0",
            label: t("workspace.followLatest", {
              revision: skill.latestRevision,
            }),
          },
          ...revisions.map((revision) => ({
            value: String(revision),
            label: t("workspace.pinnedAt", { revision }),
          })),
        ]}
        tone="pill"
        value={String(binding.pinnedRevision ?? 0)}
      />
      {error ? (
        <span className="fdy-skill-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
