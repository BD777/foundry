import type {
  DeviceSkill,
  SkillPromotionResolution,
  PromotedSkill,
} from "@foundry/protocol";
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
  const candidates = skill.serverCandidates ?? [];
  const target = candidates.find((c) => c.id === value.targetSkillId);
  const options = candidates.flatMap((c) => [
    {
      value: `reuse:${c.id}`,
      label: `Reuse ${c.name} · rev ${c.latestRevision}`,
      meta: `${c.originDeviceLabel || "Another device"} · ${c.originDirName} · ${c.originRoot}`,
      disabled:
        !(c.sourceDigest && c.sourceDigest === skill.sourceDigest) &&
        !(skill.serverState === "in_sync" && skill.promotedSkillId === c.id),
    },
    {
      value: `update:${c.id}`,
      label: `Update ${c.name} · rev ${c.latestRevision}`,
      meta: `${c.originDeviceLabel || "Another device"} · ${c.originDirName} · ${c.originRoot}`,
    },
  ]);
  if (!candidates.length)
    options.unshift({
      value: "create",
      label: "Create server entry",
      meta: "",
      disabled: false,
    });
  options.push({
    value: "fork",
    label: "Publish with a new invocation name",
    meta: "Existing workspace selections stay unchanged",
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
          ? ` · Published as ${target.name}`
          : ""}
      </small>
      <SelectMenu
        ariaLabel={`Publication action for ${skill.name}`}
        insideDialog
        disabled={disabled}
        tone="field"
        value={selected}
        placeholder="Choose a server entry or a new name"
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
          aria-label={`New invocation name for ${skill.name}`}
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
          Compare with rev {target.latestRevision}
        </Button>
      ) : null}
      {!target && candidates.length ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onCompare(skill, candidates[0]!)}
        >
          Compare server candidates
        </Button>
      ) : null}
      {value.action === "update" && target?.usedByWorkspaces?.length ? (
        <p>
          Updates future sessions in: {target.usedByWorkspaces.join(", ")}.
          Active sessions retain their original revision.
        </p>
      ) : null}
      {problem ? <p className="fdy-skill-error">{problem}</p> : null}
    </div>
  );
}
