package sqlitestore

import "github.com/foundry-dev/foundry/apps/server/internal/store"

// Normalize old JSON projections on read; new writes use the six product states.
func normalizeIssueStatus(issue store.Issue) store.Issue {
	if issue.ContractState == "" {
		issue.ContractState = "legacy_unconfirmed"
	}
	switch issue.Status {
	case "inbox", "ready":
		issue.Status = "pending"
	case "producing":
		issue.Status = "in_progress"
	case "review":
		issue.Status = "verifying"
	case "integrated":
		issue.Status = "accepted"
	case "interrupted":
		issue.Status = "blocked"
	}
	if issue.Status == "blocked" && issue.BlockedReason == nil {
		issue.BlockedReason = &store.IssueBlockedReason{Kind: "needs_input", Message: "Provide the information or decision needed to continue."}
		if issue.Run != nil {
			if issue.Run.Status == "failed" {
				issue.BlockedReason.Kind = "system_error"
			}
			if issue.Run.Error != "" {
				issue.BlockedReason.Message = issue.Run.Error
			}
		}
	}
	if issue.Status != "blocked" {
		issue.BlockedReason = nil
	}
	return issue
}
