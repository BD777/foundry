import { SkillVersionChoice } from "./skill-version-choice";
import {
  defaultSkillResolution,
  skillSourceKey,
  skillResolutionProblem,
} from "./skill-version-state";
import * as Dialog from "@radix-ui/react-dialog";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceSkill,
  PromotedSkill,
  SkillPromotionResolution,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import {
  buildSkillPromotionSelection,
  defaultSkillPromotionReferences,
  sameSkillPromotionSources,
} from "./skill-promotion-plan";
import { previewSkillPromotion, promoteSkill } from "../../api";

const SkillCompareDialog = lazy(() => import("./skill-compare-dialog"));

export function SkillPromotionDialog({
  skill,
  skills,
  online,
  onClose,
  onChanged,
}: {
  skill: DeviceSkill;
  skills: DeviceSkill[];
  online: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [related, setRelated] = useState<string[]>(() =>
    defaultSkillPromotionReferences(skill, skills),
  );
  const [choices, setChoices] = useState<
    Record<string, SkillPromotionResolution>
  >({});
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
  const resolutions = plan.skills.map(
    (s) => choices[skillSourceKey(s)] ?? defaultSkillResolution(s),
  );
  const unresolved = plan.skills.some(
    (s, i) => !!skillResolutionProblem(s, resolutions[i]!),
  );
  const alreadySynced =
    plan.skills.length > 0 &&
    plan.skills.every(
      (s, i) =>
        resolutions[i]?.action === "reuse" &&
        resolutions[i]?.targetSkillId === s.promotedSkillId,
    );
  const onlyReuse = resolutions.every((r) => r.action === "reuse");
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
      await promoteSkill({
        ...input,
        planDigest: reviewed.digest,
        includeRelated: related,
        resolutions,
      });
      await onChanged();
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
          fallback={<p role="status">{t("device.loadingComparison")}</p>}
        >
          <SkillCompareDialog
            skill={comparison.skill}
            target={comparison.target}
            onClose={() => setComparison(undefined)}
          />
        </Suspense>
      ) : null}
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-connection-assign-overlay" />
          <Dialog.Content
            className="fdy-connection-assign-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            <header className="fdy-connection-assign-header">
              <div>
                <Dialog.Title>
                  {t("promotion.title", { name: skill.name })}
                </Dialog.Title>
                <Dialog.Description>{t("promotion.body")}</Dialog.Description>
              </div>
            </header>
            <div className="fdy-skill-promotion-body" aria-busy={busy}>
              {plan ? (
                <>
                  <h3>
                    {t("promotion.toPublish", { count: plan.skills.length })}
                  </h3>
                  <ul className="fdy-skill-dependency-list">
                    {plan.skills.map((item) => (
                      <li key={`${item.root}/${item.dirName}`}>
                        <strong>{item.name}</strong>
                        <small>
                          {item.root} / {item.dirName}
                        </small>
                        <SkillVersionChoice
                          skill={item}
                          value={
                            choices[skillSourceKey(item)] ??
                            defaultSkillResolution(item)
                          }
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
                    <p className="fdy-skill-error" role="alert" key={index}>
                      {problem}
                    </p>
                  ))}
                </>
              ) : null}
              {!online ? <p role="status">{t("promotion.offline")}</p> : null}
              {error ? (
                <p className="fdy-skill-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="fdy-connection-assign-actions">
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                {t("common:actions.cancel")}
              </Button>
              <Button
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
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
