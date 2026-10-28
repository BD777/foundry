import { ToastFeedback } from "../ui/toast";
import { SkillVersionChoice } from "./skill-version-choice";
import {
  automaticSkillResolution,
  skillSourceKey,
  skillResolutionProblem,
} from "./skill-version-state";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceSkill,
  PromotedSkill,
  SkillPromotionResolution,
} from "@bd777/foundry-protocol";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Checkbox } from "../ui/field";
import {
  buildSkillPromotionSelection,
  defaultSkillPromotionReferences,
  sameSkillPromotionSources,
} from "./skill-promotion-plan";
import { previewSkillPromotion, promoteSkill } from "../../api";
import { LoadingState } from "../ui/loading";

const SkillCompareDialog = lazy(() => import("./skill-compare-dialog"));

export function SkillPromotionDialog({
  skill,
  skills,
  online,
  onClose,
  onChanged,
  onPromoted,
}: {
  skill: DeviceSkill;
  skills: DeviceSkill[];
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** The server entry the skill became, e.g. to select it in a workspace. */
  onPromoted?: (promoted: PromotedSkill) => Promise<void>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [related, setRelated] = useState<string[]>(() =>
    defaultSkillPromotionReferences(skill, skills),
  );
  // A key present with undefined means the person cleared their choice.
  const [choices, setChoices] = useState<
    Record<string, SkillPromotionResolution | undefined>
  >({});
  const resolutionFor = (s: DeviceSkill) => {
    const key = skillSourceKey(s);
    return key in choices ? choices[key] : automaticSkillResolution(s);
  };
  const [comparison, setComparison] = useState<{
    skill: DeviceSkill;
    target: PromotedSkill;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const plan = useMemo(
    () => buildSkillPromotionSelection(skill, skills, related),
    [skill, skills, related],
  );
  const chosen = plan.skills.map(resolutionFor);
  const unresolved = plan.skills.some(
    (s, i) => !!skillResolutionProblem(s, chosen[i]),
  );
  const resolutions = chosen.filter(
    (r): r is SkillPromotionResolution => r !== undefined,
  );
  const alreadySynced =
    plan.skills.length > 0 &&
    plan.skills.every(
      (s, i) =>
        resolutions[i]?.action === "reuse" &&
        resolutions[i]?.targetSkillId === s.promotedSkillId,
    );
  // Nothing from the device is published: every skill uses a library entry.
  const onlyReuse =
    !unresolved &&
    resolutions.every((r) => r.action === "reuse" || r.action === "keep");
  const input = {
    deviceId: skill.deviceId,
    root: skill.root,
    dirName: skill.dirName,
  };
  async function publish() {
    if (busy || !online || alreadySynced || unresolved || plan.problems.length)
      return;
    setBusy(true);
    setError("");
    try {
      const reviewed = await previewSkillPromotion({
        ...input,
        includeRelated: related,
        resolutions,
      });
      if (reviewed.problems.length)
        throw new Error(reviewed.problems.join("\n"));
      if (!sameSkillPromotionSources(plan.skills, reviewed.skills)) {
        throw new Error(t("promotion.graphChanged"));
      }
      const promoted = await promoteSkill({
        ...input,
        planDigest: reviewed.digest,
        includeRelated: related,
        resolutions,
      });
      await onChanged();
      await onPromoted?.(promoted);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const hints = [
    ...new Map(
      [
        ...(plan?.related ?? []),
        ...(skill.dependencies ?? []).filter((d) => d.strength === "related"),
      ].map((d) => [d.skillName, d]),
    ).values(),
  ];
  return (
    <>
      {comparison ? (
        <Suspense
          fallback={
            <LoadingState
              label={t("device.loadingComparison")}
              layout="block"
            />
          }
        >
          <SkillCompareDialog
            skill={comparison.skill}
            target={comparison.target}
            onClose={() => setComparison(undefined)}
          />
        </Suspense>
      ) : null}
      <Dialog
        busy={busy}
        description={t("promotion.body")}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                !online ||
                alreadySynced ||
                unresolved ||
                !!plan.problems.length
              }
              onClick={() => void publish()}
            >
              {busy
                ? t("promotion.publishing")
                : alreadySynced
                  ? t("promotion.alreadyInSync")
                  : onlyReuse
                    ? t("promotion.reuse", { count: plan.skills.length })
                    : t("promotion.publish", { count: plan.skills.length })}
            </Button>
          </>
        }
        layout="compact"
        onClose={onClose}
        title={t("promotion.title", { name: skill.name })}
      >
        <div className="fdy-skill-promotion-body" aria-busy={busy}>
          {plan ? (
            <>
              <h3>{t("promotion.toPublish", { count: plan.skills.length })}</h3>
              <ul className="fdy-skill-dependency-list">
                {plan.skills.map((item) => (
                  <li key={`${item.root}/${item.dirName}`}>
                    <strong>{item.name}</strong>
                    <small>
                      {item.root} / {item.dirName}
                    </small>
                    <SkillVersionChoice
                      skill={item}
                      value={resolutionFor(item)}
                      disabled={busy}
                      onChange={(r) =>
                        setChoices((old) => ({
                          ...old,
                          [skillSourceKey(item)]: r,
                        }))
                      }
                      onCompare={(skill, target) =>
                        setComparison({ skill, target })
                      }
                    />
                    {(item.dependencies ?? [])
                      .filter((d) => d.strength === "required")
                      .map((d) => (
                        <small key={`${d.skillName}:${d.evidence}`}>
                          {t("promotion.requires", {
                            name: d.skillName,
                            evidence: d.evidence,
                          })}
                        </small>
                      ))}
                  </li>
                ))}
              </ul>
              {hints.length ? (
                <>
                  <h3>{t("promotion.referencesTitle")}</h3>
                  <p>{t("promotion.referencesBody")}</p>
                  {hints.map((dep) => (
                    <label
                      className={
                        related.includes(dep.skillName)
                          ? "fdy-skill-select-row is-selected"
                          : "fdy-skill-select-row"
                      }
                      key={dep.skillName}
                    >
                      <Checkbox
                        checked={related.includes(dep.skillName)}
                        disabled={busy}
                        onChange={(e) =>
                          setRelated((current) =>
                            e.target.checked
                              ? [...current, dep.skillName]
                              : current.filter((n) => n !== dep.skillName),
                          )
                        }
                      />
                      <span className="fdy-skill-promotion-copy">
                        <strong>
                          {dep.skillName}
                          {dep.status !== "resolved"
                            ? ` · ${t(`dependencies.status.${dep.status ?? "unresolved"}`)}`
                            : ""}
                        </strong>
                        <small>{dep.evidence}</small>
                      </span>
                    </label>
                  ))}
                </>
              ) : null}
              {plan.problems.map((problem, index) => (
                <ToastFeedback tone="error" key={index} title={problem} />
              ))}
            </>
          ) : null}
          {!online ? <p role="status">{t("promotion.offline")}</p> : null}
          {error ? <ToastFeedback tone="error" title={error} /> : null}
        </div>
      </Dialog>
    </>
  );
}
