package httpapi

import (
	"context"
	"log"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// refreshIssueReview recomputes the Issue's review after a verification ends,
// so its summary (pending, passed, eligible) is current wherever the Issue
// is shown, not only after someone opens the review.
func (s *Server) refreshIssueReview(ctx context.Context, st store.EvidenceStore, issue store.Issue) {
	if _, err := st.CurrentReview(ctx, issue.ID); err != nil {
		log.Printf("refresh review of %s: %v", issue.ID, err)
		return
	}
	if current, err := s.store.GetIssue(ctx, issue.ID); err == nil {
		s.issues.updated(current)
	}
}
