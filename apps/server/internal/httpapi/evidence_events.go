package httpapi

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// publishEvidenceUpdate tells the Issue's viewers that an evidence record
// changed. The payload names its workspace but is not a struct, so it is
// published into the workspace explicitly.
func (s *Server) publishEvidenceUpdate(issue store.Issue, id string, version int, status string) {
	s.events.PublishIn(issue.WorkspaceID, "evidence_updated", map[string]any{
		"issueId": issue.ID, "workspaceId": issue.WorkspaceID,
		"entityId": id, "version": version, "status": status,
	})
}

// refreshIssueReview recomputes the Issue's review after a verification ends,
// so its summary (pending, passed, eligible) is current wherever the Issue
// is shown, not only after someone opens the review.
func (s *Server) refreshIssueReview(ctx context.Context, st store.EvidenceStore, issue store.Issue) {
	if _, err := st.CurrentReview(ctx, issue.ID); err != nil {
		log.Printf("refresh review of %s: %v", issue.ID, err)
		return
	}
	if current, err := s.store.GetIssue(ctx, issue.ID); err == nil {
		s.events.Publish("issue_updated", current)
	}
}
