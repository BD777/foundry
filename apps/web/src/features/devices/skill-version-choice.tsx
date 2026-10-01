import type {
  DeviceSkill,
  SkillPromotionResolution,
  PromotedSkill,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { SelectMenu } from "../../components/ui/select-menu";
import { TextInput } from "../../components/ui/field";
import { Button } from "../../components/ui/button";
import {
  skillResolutionProblem,
  skillServerLabel,
} from "./skill-version-state";

export function SkillVersionChoice({
  skill,
  value,
  onChange,
  onCompare,
  disabled,
}: {
  skill: DeviceSkill;
  value: SkillPromotionResolution;
  onChange: (r: SkillPromotionResolution) => void;
  onCompare: (s: DeviceSkill, c: PromotedSkill) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("skills");
  const candidates = skill.serverCandidates ?? [];
  const target = candidates.find((c) => c.id === value.targetSkillId);
  const options = candidates.flatMap((c) => [
    {
      value: `reuse:${c.id}`,
      label: t("versionChoice.reuse", {
        name: c.name,
        revision: c.latestRevision,
      }),
      meta: `${c.originDeviceLabel || t("versionChoice.anotherDevice")} · ${c.originDirName} · ${c.originRoot}`,
      disabled:
        !(c.sourceDigest && c.sourceDigest === skill.sourceDigest) &&
        !(skill.serverState === "in_sync" && skill.promotedSkillId === c.id),
    },
    {
      value: `update:${c.id}`,
      label: t("versionChoice.update", {
        name: c.name,
        revision: c.latestRevision,
      }),
      meta: `${c.originDeviceLabel || t("versionChoice.anotherDevice")} · ${c.originDirName} · ${c.originRoot}`,
    },
  ]);
  if (!candidates.length)
    options.unshift({
      value: "create",
      label: t("versionChoice.create"),
      meta: "",
      disabled: false,
    });
  options.push({
    value: "fork",
    label: t("versionChoice.fork"),
    meta: t("versionChoice.forkMeta"),
    disabled: false,
  });
  const selected =
    value.action === "fork"
      ? "fork"
      : value.targetSkillId
        ? `${value.action}:${value.targetSkillId}`
        : candidates.length
          ? ""
          : "create";
  const problem = skillResolutionProblem(skill, value);
  return (
    <div className="fdy-skill-version-choice">
      <small>
        {skillServerLabel(skill)}
        {target && target.name !== skill.name
          ? t("versionChoice.publishedAs", { name: target.name })
          : ""}
      </small>
      <SelectMenu
        ariaLabel={t("versionChoice.actionLabel", { name: skill.name })}
        insideDialog
        disabled={disabled}
        tone="field"
        value={selected}
        placeholder={t("versionChoice.placeholder")}
        options={options}
        onChange={(next) => {
          const [action, id] = next.split(":");
          const c = candidates.find((c) => c.id === id);
          onChange({
            root: skill.root,
            dirName: skill.dirName,
            action: action as SkillPromotionResolution["action"],
            ...(c
              ? { targetSkillId: c.id, expectedRevision: c.latestRevision }
              : {}),
          });
        }}
      />
      {value.action === "fork" ? (
        <TextInput
          tone="boxed"
          aria-label={t("versionChoice.newNameLabel", { name: skill.name })}
          // i18n-ignore: an example identifier, not prose
          placeholder="team-skill-name"
          value={value.name ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      ) : null}
      {target ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onCompare(skill, target)}
        >
          {t("versionChoice.compareRevision", {
            revision: target.latestRevision,
          })}
        </Button>
      ) : null}
      {!target && candidates.length ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onCompare(skill, candidates[0]!)}
        >
          {t("versionChoice.compareCandidates")}
        </Button>
      ) : null}
      {value.action === "update" && target?.usedByWorkspaces?.length ? (
        <p>
          {t("versionChoice.updatesSessions", {
            workspaces: target.usedByWorkspaces.join(", "),
          })}
        </p>
      ) : null}
      {problem ? <p className="fdy-skill-error">{problem}</p> : null}
    </div>
  );
}
