import type { IssueEnvironmentData } from "../../api";
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
  const labels: Record<string, string> = {
    not_prepared: "Not prepared",
    unprepared: "Not prepared",
    ready: "Ready",
    preparing: "Preparing",
    running: "Running",
    review: "Awaiting review",
    failed: "Preparation failed",
    integrated: "Integrated",
    cleaned: "Cleaned",
    unavailable: "Unavailable",
    unborn: "Needs initial commit",
    conflict: "Boundary conflict",
    unknown: "Unknown",
  };
  return labels[status] ?? status;
}
