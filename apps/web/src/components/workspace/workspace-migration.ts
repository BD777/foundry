import type {
  DeviceProjection,
  WorkspaceMigration,
  WorkspaceMigrationState,
  WorkspaceMigrationSummary,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { formatBytes } from "../../lib/format";

/**
 * Moving a workspace to another device (DEV-146), as the Web reads it: which
 * states pause the workspace, which can be canceled, how far the copy got
 * and where the folder goes by default.
 */

type MigrationLike = Pick<WorkspaceMigrationSummary, "state">;

const endedStates: readonly WorkspaceMigrationState[] = [
  "complete",
  "canceled",
  "failed",
];

/** The move is still under way (not complete, canceled or failed). */
export function migrationActive(migration?: MigrationLike): boolean {
  return !!migration && !endedStates.includes(migration.state);
}

/** No sessions or messages run in the workspace while it is copied and switched. */
export function migrationFrozen(migration?: MigrationLike): boolean {
  return (
    migration?.state === "copying" ||
    migration?.state === "verifying" ||
    migration?.state === "activating"
  );
}

/**
 * Why nothing can start in the workspace now, or undefined: it is paused
 * while it moves (the server refuses new chats and messages meanwhile).
 */
export function migrationPauseReason(
  workspace: Pick<WorkspaceProjection, "migration"> | undefined,
): string | undefined {
  const migration = workspace?.migration;
  if (!migration || !migrationFrozen(migration)) return undefined;
  return i18n.t("workspaces:move.pausedNote", {
    device: migration.targetDeviceLabel,
  });
}

/** A move that ended in failure, kept in the summary until another starts. */
export function migrationFailed(migration?: MigrationLike): boolean {
  return migration?.state === "failed";
}

/** Before the switch the move can still be canceled; nothing changed on the source. */
export function migrationCancelable(migration?: MigrationLike): boolean {
  return (
    migration?.state === "preflight" ||
    migration?.state === "copying" ||
    migration?.state === "verifying"
  );
}

/** A complete move whose old copy on the source device is still there. */
export function migrationLeftOldCopy(
  migration?: WorkspaceMigrationSummary,
): migration is WorkspaceMigrationSummary {
  return migration?.state === "complete";
}

/** The workspaces whose old copy a complete move left on `deviceId`. */
export function oldCopiesOn(
  workspaces: readonly WorkspaceProjection[],
  deviceId: string,
): WorkspaceProjection[] {
  return workspaces.filter(
    (workspace) =>
      migrationLeftOldCopy(workspace.migration) &&
      workspace.migration.sourceDeviceId === deviceId,
  );
}

const migrationSteps = [
  "queued",
  "checking",
  "scanning",
  "checking_target",
  "streaming",
  "retrying",
  "copying_changes",
  "verifying_target",
  "rescanning",
  "activating_target",
  "retiring_source",
  "aborting",
] as const;
type MigrationStep = (typeof migrationSteps)[number];

/** The `move.steps.*` key of a sub-step, or undefined for one this build does not know. */
export function migrationStepKey(
  step?: string,
): `move.steps.${MigrationStep}` | undefined {
  return step && (migrationSteps as readonly string[]).includes(step)
    ? `move.steps.${step as MigrationStep}`
    : undefined;
}

const migrationReasons = [
  "device_offline",
  "worker_outdated",
  "target_path_taken",
  "target_path_unavailable",
  "not_enough_space",
  "workspace_busy",
  "device_refused",
  "transfer_retrying",
  "transfer_failed",
  "verify_mismatch",
  "canceled_by_person",
] as const;
type MigrationReason = (typeof migrationReasons)[number];

/** The `move.reasons.*` key of a reason code, or undefined for an unknown one. */
export function migrationReasonKey(
  code?: string,
): `move.reasons.${MigrationReason}` | undefined {
  return code && (migrationReasons as readonly string[]).includes(code)
    ? `move.reasons.${code as MigrationReason}`
    : undefined;
}

/**
 * How far the copy got, for a ProgressMeter: bytes of the total once the
 * source scan knows it; undefined (indeterminate) before.
 */
export function migrationProgress(
  migration: Pick<
    WorkspaceMigrationSummary,
    "bytes" | "totalBytes" | "files" | "totalFiles"
  >,
): { value: number; max: number } | undefined {
  const total = migration.totalBytes ?? 0;
  if (total > 0)
    return { value: Math.min(migration.bytes ?? 0, total), max: total };
  const files = migration.totalFiles ?? 0;
  if (files > 0)
    return { value: Math.min(migration.files ?? 0, files), max: files };
  return undefined;
}

/** Whether the copy has counts worth showing (the source scan finished). */
export function migrationHasCounts(
  migration: Pick<WorkspaceMigrationSummary, "totalBytes" | "totalFiles">,
): boolean {
  return (migration.totalBytes ?? 0) > 0 || (migration.totalFiles ?? 0) > 0;
}

/** A size in a move's progress and results: "734 KB", "8.4 MB", "3.6 GB". */
export function migrationSize(bytes: number): string {
  return formatBytes(bytes, { gb: true, mbDigits: "adaptive" });
}

/** A file count in the reader's number format: "18,234". */
export function migrationCount(count: number): string {
  return count.toLocaleString(i18n.language);
}

/** The last segment of a POSIX or Windows path. */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function parentOf(path: string): string | undefined {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  if (cut === 0) return trimmed[0];
  return trimmed.slice(0, cut);
}

/**
 * Where the folder goes on the target device by default: beside the
 * workspaces already there (the parent most of them share), else in its
 * home folder; under the workspace's own folder name either way.
 */
export function suggestMigrationTargetPath(
  sourcePath: string,
  targetWorkspacePaths: readonly string[],
): string {
  const name = folderName(sourcePath) || "workspace";
  const counts = new Map<string, number>();
  for (const path of targetWorkspacePaths) {
    const parent = parentOf(path);
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [parent, count] of counts)
    if (count > bestCount) [best, bestCount] = [parent, count];
  if (!best) return `~/${name}`;
  const separator = best.includes("\\") && !best.includes("/") ? "\\" : "/";
  return best.endsWith(separator)
    ? `${best}${name}`
    : `${best}${separator}${name}`;
}

/** Why a device cannot take the workspace, as a `move.deviceReasons.*` key; undefined when it can. */
export function moveTargetDenial(
  device: Pick<DeviceProjection, "id" | "status" | "owned">,
  sourceDeviceId: string,
): "current" | "notOwned" | "offline" | undefined {
  if (device.id === sourceDeviceId) return "current";
  if (!device.owned) return "notOwned";
  if (device.status !== "connected") return "offline";
  return undefined;
}

/** Whether `next` is a newer reading of the same move than `held`. */
export function newerMigration(
  held: WorkspaceMigration | undefined,
  next: WorkspaceMigration,
): boolean {
  if (!held || held.id !== next.id) return true;
  return next.updatedAt >= held.updatedAt;
}
