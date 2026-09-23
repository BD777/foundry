package sqlitestore

import (
	"context"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Authority-level chat-layout mutations used by orchestration internals
// (auto placement, AI group naming). These bypass the browser-facing
// expectedRevision CAS because there is no stale client snapshot to protect;
// they bump the revision so open browsers refresh.

// RenameLayoutGroup renames one group without changing membership.
func (s *Store) RenameLayoutGroup(ctx context.Context, workspaceID, groupID, name string) (store.ChatLayout, error) {
	var result store.ChatLayout
	err := s.withTx(ctx, func(tx *Store) error {
		layout, err := tx.GetChatLayout(ctx, workspaceID)
		if err != nil {
			return err
		}
		index := -1
		for i, group := range layout.Groups {
			if group.ID == groupID {
				index = i
				break
			}
		}
		if index < 0 {
			return store.ErrNotFound
		}
		name = strings.TrimSpace(name)
		if name == "" {
			return store.ErrInvalidChatLayout
		}
		taken := map[string]bool{}
		for _, group := range layout.Groups {
			if group.ID != groupID {
				taken[group.Name] = true
			}
		}
		layout.Groups[index].Name = uniqueAutoGroupName(name, taken)
		if err := tx.persistLayout(ctx, workspaceID, layout); err != nil {
			return err
		}
		layout.Revision++
		result = layout
		return nil
	})
	return result, err
}

// CreateGroupNameJob dispatches a source=naming utility session whose response
// renames the given orchestration group. A failure leaves the deterministic
// name in place.
func (s *Store) CreateGroupNameJob(ctx context.Context, input store.CreateAgentSessionInput, groupID string) (store.AgentSession, error) {
	// The naming session carries the target group only in its payload, never
	// inherited transcript/native context.
	input.Source = "naming"
	input.NativeSessionID = ""
	input.ThreadID = ""
	input.ImportedContext = ""
	input.ProfileTransitionNote = ""
	input.Attachments = nil
	session, err := s.CreateAgentSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	session.GroupNameTarget = strings.TrimSpace(groupID)
	now := time.Now().UTC()
	if err := s.saveAgentSession(ctx, session, time.Time{}, now); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}
