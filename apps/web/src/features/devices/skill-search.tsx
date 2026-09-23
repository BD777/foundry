import type { DeviceSkill } from "@foundry/protocol";

export type SkillServerFilter =
  "all" | "unpublished" | "different" | "same_name" | "in_sync" | "unknown";

/** Rank the displayed title ahead of descriptions and source metadata. */
export function searchDeviceSkills(
  skills: DeviceSkill[],
  filter: string,
  serverFilter: SkillServerFilter | boolean = "all",
): DeviceSkill[] {
  const query = filter.trim().toLowerCase();
  const rank = (s: DeviceSkill): number => {
    if (!query) return 0;
    const title = s.name.toLowerCase();
    if (title === query) return 0;
    if (title.startsWith(query)) return 1;
    if (title.includes(query)) return 2;
    if (s.description.toLowerCase().includes(query)) return 3;
    if (s.dirName.toLowerCase().includes(query)) return 4;
    if (s.root.toLowerCase().includes(query)) return 5;
    return Infinity;
  };
  return skills
    .filter((skill) => {
      if (serverFilter === true || serverFilter === "unpublished")
        return !skill.promotedSkillId;
      if (
        serverFilter === "different" ||
        serverFilter === "in_sync" ||
        serverFilter === "unknown"
      )
        return skill.serverState === serverFilter;
      if (serverFilter === "same_name")
        return (
          skill.serverState === "name_conflict" ||
          skill.serverState === "reusable"
        );
      return true;
    })
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((item) => Number.isFinite(item.rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.skill.root.localeCompare(b.skill.root) ||
        a.skill.name.localeCompare(b.skill.name) ||
        a.skill.dirName.localeCompare(b.skill.dirName),
    )
    .map((item) => item.skill);
}

/** Literal, case-insensitive matches; React escapes all source text. */
export function SkillSearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const term = query.trim();
  if (!term) return <>{text}</>;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(escaped, "gi"))];
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.index));
    parts.push(
      <mark className="fdy-skill-search-match" key={match.index}>
        {match[0]}
      </mark>,
    );
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
