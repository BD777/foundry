package sqlitestore

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// nativeSessionSet collects native sessions once each.
type nativeSessionSet map[store.NativeSessionRef]bool

func (set nativeSessionSet) add(provider, id string) {
	provider, id = strings.TrimSpace(provider), strings.TrimSpace(id)
	if id == "" || (provider != "claude" && provider != "codex") {
		return
	}
	set[store.NativeSessionRef{Provider: provider, NativeSessionID: id}] = true
}

func (set nativeSessionSet) list() []store.NativeSessionRef {
	refs := make([]store.NativeSessionRef, 0, len(set))
	for ref := range set {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(a, b int) bool {
		if refs[a].Provider != refs[b].Provider {
			return refs[a].Provider < refs[b].Provider
		}
		return refs[a].NativeSessionID < refs[b].NativeSessionID
	})
	return refs
}

// WorkspaceNativeSessions lists the native sessions of a live workspace's
// chats: its Foundry sessions' and the native chats synced into it.
func (s *Store) WorkspaceNativeSessions(ctx context.Context, workspaceID string) ([]store.NativeSessionRef, error) {
	refs := nativeSessionSet{}
	for _, query := range []string{
		`SELECT provider, COALESCE(json_extract(payload_json, '$.nativeSessionId'), '') FROM agent_sessions WHERE workspace_id = ?1`,
		`SELECT n.provider, n.native_id FROM agent_session_native_ids n
			JOIN agent_sessions a ON a.id = n.session_id WHERE a.workspace_id = ?1`,
		`SELECT provider, native_session_id FROM chats WHERE workspace_id = ?1`,
	} {
		rows, err := s.reader().QueryContext(ctx, query, workspaceID)
		if err != nil {
			return nil, fmt.Errorf("list native sessions: %w", err)
		}
		for rows.Next() {
			var provider, id string
			if err := rows.Scan(&provider, &id); err != nil {
				rows.Close()
				return nil, err
			}
			refs.add(provider, id)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return refs.list(), nil
}
