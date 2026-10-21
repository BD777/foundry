package httpapi

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// assistantWorkspaceCandidates is the routing projection of readable history.
// A removed device's digest stays readable through get_workspace and its old
// work stays attributable, but neither the prompt index nor find_workspace may
// propose it for new work. Shared workspaces retain their membership scope.
func (s *Server) assistantWorkspaceCandidates(ctx context.Context, userID string) ([]store.WorkspaceDigestRecord, error) {
	records, err := s.workspaceDigests().Sync(ctx, userID)
	if err != nil {
		return nil, err
	}
	devices, err := store.DeviceCandidates(ctx, s.store)
	if err != nil {
		return nil, err
	}
	available := map[string]bool{"": true}
	for _, device := range devices {
		available[device.ID] = true
	}
	candidates := make([]store.WorkspaceDigestRecord, 0, len(records))
	for _, record := range records {
		if available[record.Digest.DeviceID] {
			candidates = append(candidates, record)
		}
	}
	return candidates, nil
}
