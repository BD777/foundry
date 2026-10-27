import type { ToastTone } from "../../components/ui/toast";
/**
 * Callbacks the issue-detail view needs from the app shell. Keeping these
 * as an interface lets the view stay decoupled from App state and handlers.
 * What its actions change reaches the app as stream events (issue_updated,
 * evidence_updated, foundry_data_changed): nothing reads it after them.
 */
export interface IssueActionCallbacks {
  onDraftFromSource: (text: string) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
}
