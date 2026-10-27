import type { ArchiveBlocker } from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

/** Codes are stable UI copy; legacy server prose is never a locale fallback. */
export function archiveBlockerReason(blocker: ArchiveBlocker): string {
  switch (blocker.code) {
    case "running":
      return i18n.t("chat:archive.reasons.running");
    case "personal_agent":
      return i18n.t("chat:archive.reasons.personal_agent");
    case "issue_owned":
      return i18n.t("chat:archive.reasons.issue_owned", {
        issueId: blocker.issueId || i18n.t("chat:archive.unnamedIssue"),
      });
    case "work_unpausable":
      return i18n.t("chat:archive.reasons.work_unpausable", {
        workTitle: blocker.workTitle || i18n.t("chat:archive.unnamedWork"),
      });
    case "work_shared":
      return i18n.t("chat:archive.reasons.work_shared", {
        workTitle: blocker.workTitle || i18n.t("chat:archive.unnamedWork"),
      });
    default:
      return i18n.t("chat:archive.reasons.unknown");
  }
}
