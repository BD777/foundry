import type {
  WorkerGroupDomain,
  WorkerGroupMember,
} from "@bd777/foundry-protocol";

/** Tier 1 is a primary member, tier 2 a fallback. A member without a tier is primary. */
export function memberTier(member: Pick<WorkerGroupMember, "tier">): 1 | 2 {
  return member.tier === 2 ? 2 : 1;
}

/** The rate-limit domain a member runs on: its account and runtime. */
export function domainForMember(
  domains: readonly WorkerGroupDomain[],
  member: { providerId: string; runtime: string },
): WorkerGroupDomain | undefined {
  return domains.find(
    (domain) =>
      domain.profileId === member.providerId &&
      domain.runtime === member.runtime,
  );
}

const MS_PER_MINUTE = 60_000;

export type DomainStatusKey =
  | "workerGroups.domain.healthy"
  | "workerGroups.domain.limited"
  | "workerGroups.domain.limitedNoEta"
  | "workerGroups.domain.probing"
  | "workerGroups.domain.recovering";

export interface DomainStatus {
  state: WorkerGroupDomain["state"];
  /** Translation key of the state text, with `values` for its placeholders. */
  key: DomainStatusKey;
  values: { active: number; limit: number; minutes: number };
  /** Switches to a fallback in the last hour; 0 hides the note. */
  failoversLastHour: number;
}

/**
 * Maps a domain to the text of its status line. `now` is epoch milliseconds, so
 * the cooldown minutes are relative to the moment the page renders.
 */
export function domainStatus(
  domain: WorkerGroupDomain,
  now: number,
): DomainStatus {
  const base = {
    state: domain.state,
    values: {
      active: domain.active,
      limit: domain.limit,
      minutes: remainingMinutes(domain.cooldownUntil, now),
    },
    failoversLastHour: domain.failoversLastHour,
  };
  switch (domain.state) {
    case "healthy":
      return { ...base, key: "workerGroups.domain.healthy" };
    case "limited":
      return {
        ...base,
        key:
          base.values.minutes > 0
            ? "workerGroups.domain.limited"
            : "workerGroups.domain.limitedNoEta",
      };
    case "probing":
      return { ...base, key: "workerGroups.domain.probing" };
    case "recovering":
      return { ...base, key: "workerGroups.domain.recovering" };
  }
}

/** Whole minutes until the cooldown ends, rounded up; 0 when unknown or past. */
function remainingMinutes(cooldownUntil: string | undefined, now: number) {
  if (!cooldownUntil) return 0;
  const until = Date.parse(cooldownUntil);
  if (Number.isNaN(until) || until <= now) return 0;
  return Math.ceil((until - now) / MS_PER_MINUTE);
}
