/**
 * Callbacks the issue-detail view needs from the app shell. Keeping these
 * as an interface lets the view stay decoupled from App state and handlers.
 */
export interface IssueActionCallbacks {
  onDraftFromSource: (text: string) => void;
  onNotice: (message: string) => void;
  onRefresh: (issueId?: string) => void;
}
