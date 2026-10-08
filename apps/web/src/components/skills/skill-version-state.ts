import type {
  DeviceSkill,
  SkillPromotionResolution,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
export const skillSourceKey = (s: Pick<DeviceSkill, "root" | "dirName">) =>
  `${s.root}\0${s.dirName}`;
export function skillServerLabel(s: DeviceSkill): string {
  const revision = s.serverRevision
    ? i18n.t("skills:serverState.revision", { revision: s.serverRevision })
    : "";
  switch (s.serverState) {
    case "in_sync":
      return i18n.t("skills:serverState.inSync", { revision });
    case "different":
      return i18n.t("skills:serverState.different", { revision });
    case "reusable":
      return i18n.t("skills:serverState.reusable");
    case "name_conflict":
      return i18n.t("skills:serverState.nameConflict");
    case "unknown":
      return i18n.t("skills:serverState.unknown");
    default:
      return s.promotedSkillId
        ? i18n.t("skills:serverState.onServer")
        : i18n.t("skills:serverState.notPublished");
  }
}
export function defaultSkillResolution(
  s: DeviceSkill,
): SkillPromotionResolution {
  const base = { root: s.root, dirName: s.dirName };
  const linked = s.serverCandidates?.find((c) => c.id === s.promotedSkillId);
  if (linked)
    return {
      ...base,
      action: s.serverState === "in_sync" ? "reuse" : "update",
      targetSkillId: linked.id,
      expectedRevision: linked.latestRevision,
    };
  const identical = s.serverCandidates?.find(
    (c) => c.sourceDigest && c.sourceDigest === s.sourceDigest,
  );
  if (identical)
    return {
      ...base,
      action: "reuse",
      targetSkillId: identical.id,
      expectedRevision: identical.latestRevision,
    };
  return { ...base, action: "create" };
}
export function skillResolutionProblem(
  s: DeviceSkill,
  r: SkillPromotionResolution,
): string | undefined {
  if (!s.serverState) return i18n.t("skills:resolution.refreshFirst");
  if (r.action === "create" && s.serverCandidates?.length)
    return i18n.t("skills:resolution.chooseSameName", { name: s.name });
  if (
    r.action === "fork" &&
    ((r.name ?? "").length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.name ?? ""))
  )
    return i18n.t("skills:resolution.invalidName");
  if (r.action === "fork" && r.name === s.name)
    return i18n.t("skills:resolution.forkSameName");
  return undefined;
}
