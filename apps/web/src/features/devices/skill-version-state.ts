import type { DeviceSkill, SkillPromotionResolution } from "@foundry/protocol";
export const skillSourceKey = (s: Pick<DeviceSkill, "root" | "dirName">) =>
  `${s.root}\0${s.dirName}`;
export function skillServerLabel(s: DeviceSkill): string {
  const rev = s.serverRevision ? ` · rev ${s.serverRevision}` : "";
  switch (s.serverState) {
    case "in_sync":
      return `In sync${rev}`;
    case "different":
      return `Local differs${rev}`;
    case "reusable":
      return "Identical on server";
    case "name_conflict":
      return "Same-name conflict";
    case "unknown":
      return "Comparison unavailable";
    default:
      return s.promotedSkillId ? "On server" : "Not published";
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
  if (!s.serverState) return "Refresh server status before publishing.";
  if (r.action === "create" && s.serverCandidates?.length)
    return `Choose how to resolve ${s.name}'s same-name server entry.`;
  if (
    r.action === "fork" &&
    ((r.name ?? "").length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.name ?? ""))
  )
    return "Enter a distinct invocation name (lowercase letters, numbers and hyphens).";
  if (r.action === "fork" && r.name === s.name)
    return "A fork must use a distinct invocation name.";
  return undefined;
}
