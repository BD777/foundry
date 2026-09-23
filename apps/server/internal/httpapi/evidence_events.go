package httpapi

import "github.com/foundry-dev/foundry/apps/server/internal/store"

func (s *Server) publishEvidenceUpdate(issue store.Issue, id string, version int, status string) {
	s.events.Publish("evidence_updated", map[string]any{
		"issueId": issue.ID, "workspaceId": issue.WorkspaceID,
		"entityId": id, "version": version, "status": status,
	})
}
