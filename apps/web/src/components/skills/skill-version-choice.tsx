import { i18n } from "../../i18n";
import type {
  DeviceSkill,
  SkillPromotionResolution,
  PromotedSkill,
} from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { SegmentedControl } from "../ui/segmented-control";
import { SelectMenu } from "../ui/select-menu";
import {
  automaticSkillResolution,
  skillConflictTarget,
  skillResolutionProblem,
} from "./skill-version-state";

/**
 * What publishing does with one skill. Nothing to decide when the library
 * lacks it (it is added) or already holds its content (it is reused). A
 * same-named library entry with other content is shown beside this device's
 * version, and the person picks one; publishing under another name stays a
 * secondary way out.
 */
/** Local date and time for a timestamp label; other labels show as they are. */
function readableTime(label: string | undefined): string {
  if (!label) return "—";
  const time = new Date(label);
  return Number.isNaN(time.getTime())
    ? label
    : time.toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function SkillVersionChoice({
  skill,
  value,
  onChange,
  onCompare,
  disabled,
}: {
  skill: DeviceSkill;
  /** Absent until the person chooses, when a choice is needed. */
  value: SkillPromotionResolution | undefined;
  onChange: (r: SkillPromotionResolution | undefined) => void;
  onCompare: (s: DeviceSkill, c: PromotedSkill) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("skills");
  const base = { root: skill.root, dirName: skill.dirName };
  const automatic = automaticSkillResolution(skill);
  const candidates = skill.serverCandidates ?? [];
  const target =
    candidates.find((c) => c.id === value?.targetSkillId) ??
    skillConflictTarget(skill);
  const problem = value ? skillResolutionProblem(skill, value) : undefined;
  const forking = value?.action === "fork";

  const fork = forking ? (
    <div className="fdy-skill-version-fork">
      <TextInput
        tone="boxed"
        aria-label={t("versionChoice.newNameLabel", { name: skill.name })}
        // i18n-ignore: an example identifier, not prose
        placeholder="team-skill-name"
        value={value.name ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onChange(automatic)}
      >
        {t(
          automatic?.action === "create"
            ? "versionChoice.useOriginalName"
            : "versionChoice.backToVersions",
          { name: skill.name },
        )}
      </Button>
    </div>
  ) : (
    <Button
      className="fdy-skill-version-secondary"
      size="sm"
      variant="ghost"
      disabled={disabled}
      onClick={() => onChange({ ...base, action: "fork", name: "" })}
    >
      {t("versionChoice.anotherName")}
    </Button>
  );

  if (automatic?.action === "create")
    return (
      <div className="fdy-skill-version-choice">
        {forking ? null : <p>{t("versionChoice.newSkill")}</p>}
        {fork}
        {problem ? <p className="fdy-skill-error">{problem}</p> : null}
      </div>
    );

  if (automatic?.action === "reuse") {
    const entry = candidates.find((c) => c.id === automatic.targetSkillId);
    return (
      <div className="fdy-skill-version-choice">
        <p>
          {t("versionChoice.existing", {
            name: entry?.name ?? skill.name,
            revision: entry?.latestRevision,
          })}
        </p>
      </div>
    );
  }

  if (!target) return null;
  const chosen =
    value?.action === "update" || value?.action === "keep" ? value.action : "";
  const choose = (action: "update" | "keep") =>
    onChange({
      ...base,
      action,
      targetSkillId: target.id,
      expectedRevision: target.latestRevision,
    });
  const from = target.originDeviceId.startsWith("repo:")
    ? `${target.originRoot} · ${target.originDirName}`
    : `${target.originDeviceLabel || t("versionChoice.anotherDevice")} · ${target.originRoot}/${target.originDirName}`;
  return (
    <div className="fdy-skill-version-choice">
      <p>{t("versionChoice.conflict", { name: target.name })}</p>
      {candidates.length > 1 ? (
        <SelectMenu
          ariaLabel={t("versionChoice.entryLabel", { name: skill.name })}
          insideDialog
          disabled={disabled || forking}
          tone="field"
          value={target.id}
          options={candidates.map((c) => ({
            value: c.id,
            label: t("versionChoice.entry", {
              name: c.name,
              revision: c.latestRevision,
            }),
            meta: c.originDeviceLabel || c.originRoot,
          }))}
          onChange={(id) => {
            const next = candidates.find((c) => c.id === id);
            if (next && chosen)
              onChange({
                ...base,
                action: chosen,
                targetSkillId: next.id,
                expectedRevision: next.latestRevision,
              });
            else onChange(undefined);
          }}
        />
      ) : null}
      <div className="fdy-skill-version-compare">
        <section>
          <h4>{t("versionChoice.inLibrary")}</h4>
          <dl>
            <dt>{t("versionChoice.version")}</dt>
            <dd>
              {t("versionChoice.revision", { revision: target.latestRevision })}
            </dd>
            <dt>{t("versionChoice.updated")}</dt>
            <dd>{readableTime(target.updatedLabel)}</dd>
            <dt>{t("versionChoice.from")}</dt>
            <dd>{from}</dd>
            <dt>{t("versionChoice.usedBy")}</dt>
            <dd>
              {target.usedByWorkspaces?.length
                ? target.usedByWorkspaces.join(", ")
                : t("versionChoice.notUsed")}
            </dd>
          </dl>
        </section>
        <section>
          <h4>{t("versionChoice.onDevice")}</h4>
          <dl>
            <dt>{t("versionChoice.folder")}</dt>
            <dd>
              {skill.root}/{skill.dirName}
            </dd>
            <dt>{t("versionChoice.modified")}</dt>
            <dd>{readableTime(skill.mtimeLabel)}</dd>
          </dl>
        </section>
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => onCompare(skill, target)}
      >
        {t("versionChoice.compareFiles")}
      </Button>
      {forking ? null : (
        <>
          <SegmentedControl
            aria-label={t("versionChoice.actionLabel", { name: skill.name })}
            onValueChange={choose}
            options={[
              {
                value: "update" as const,
                label: t("versionChoice.useDevice"),
                disabled,
              },
              {
                value: "keep" as const,
                label: t("versionChoice.keepLibrary"),
                disabled,
              },
            ]}
            size="sm"
            value={chosen as "update" | "keep"}
          />
          <p>
            {chosen === "update"
              ? t("versionChoice.useDeviceResult", {
                  revision: target.latestRevision + 1,
                })
              : chosen === "keep"
                ? t("versionChoice.keepLibraryResult", {
                    revision: target.latestRevision,
                  })
                : t("versionChoice.chooseVersion")}
          </p>
        </>
      )}
      {fork}
      {problem ? <p className="fdy-skill-error">{problem}</p> : null}
    </div>
  );
}
