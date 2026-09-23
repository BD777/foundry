import type { ReactNode } from "react";
import type { NormalizedSkill } from "./skill-models";

/** Literal, case-insensitive matches; React escapes all source text. */
export function SkillSearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  const term = query.trim();
  if (!term || !text) return <>{text}</>;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(escaped, "gi"))];
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index !== undefined && match.index > cursor) {
      parts.push(text.slice(cursor, match.index));
    }
    parts.push(
      <mark className="fdy-skill-search-match" key={match.index}>
        {match[0]}
      </mark>,
    );
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}

/**
 * Generic search & ranking algorithm prioritizing title match over descriptions and paths.
 */
export function searchNormalizedSkills<T extends NormalizedSkill>(
  skills: T[],
  query: string,
  filterPredicate?: (skill: T) => boolean,
): T[] {
  const term = query.trim().toLowerCase();
  const rank = (s: T): number => {
    if (!term) return 0;
    const nameLower = s.name.toLowerCase();
    if (nameLower === term) return 0;
    if (nameLower.startsWith(term)) return 1;
    if (nameLower.includes(term)) return 2;
    if (s.description?.toLowerCase().includes(term)) return 3;
    if (s.subtitle?.toLowerCase().includes(term)) return 4;
    return Infinity;
  };

  return skills
    .filter((skill) => {
      if (filterPredicate && !filterPredicate(skill)) return false;
      return true;
    })
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((item) => Number.isFinite(item.rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.skill.name.localeCompare(b.skill.name) ||
        a.skill.id.localeCompare(b.skill.id),
    )
    .map((item) => item.skill);
}
