import type { IssueEnvironmentData } from "../../api";
import { en } from "../../i18n/resources";
import { i18n } from "../../i18n";
export type EnvironmentRepository =
  IssueEnvironmentData["repositories"][number];

export function repositoryState(
  repo: EnvironmentRepository,
  environmentStatus: string,
) {
  const candidate =
    environmentStatus === "not_prepared" ? "unprepared" : repo.status;
  const availability =
    repo.availability ??
    (environmentStatus === "not_prepared" ? repo.status : "unknown");
  return {
    candidate,
    availability,
    unavailable:
      ["unavailable", "conflict", "unborn"].includes(availability) ||
      candidate === "failed",
  };
}

export function environmentCounts(data: IssueEnvironmentData) {
  const states = data.repositories.map((repo) =>
    repositoryState(repo, data.status),
  );
  return {
    registered: states.length,
    prepared: states.filter((state) => state.candidate === "ready").length,
    unavailable: states.filter((state) => state.unavailable).length,
  };
}

export function environmentLabel(status: string): string {
  return status in en.issueDetail.environmentStatus
    ? i18n.t(
        `issueDetail:environmentStatus.${status as keyof typeof en.issueDetail.environmentStatus}`,
      )
    : status;
}
