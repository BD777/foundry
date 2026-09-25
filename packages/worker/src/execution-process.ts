const active = new Map<string, AbortController>();
const pending = new Set<string>();
export function beginIssueExecution(issueId: string): AbortController {
  if (active.has(issueId))
    throw new Error("Issue already has an active execution");
  const control = new AbortController();
  active.set(issueId, control);
  if (pending.delete(issueId))
    control.abort(new Error("Issue execution canceled"));
  return control;
}
export function finishIssueExecution(issueId: string): void {
  active.delete(issueId);
  pending.delete(issueId);
}
export function cancelIssueExecution(issueId: string): void {
  const control = active.get(issueId);
  if (control) control.abort(new Error("Issue execution canceled"));
  else pending.add(issueId);
}
export function executionActive(issueId: string): boolean {
  return active.has(issueId);
}
