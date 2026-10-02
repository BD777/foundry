package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// Session lineage and automatic chat-layout placement for CHAT-01 (an agent
// session creating further sessions). The layout mutation is server-authority:
// it runs inside the create transaction, bumps the revision directly and never
// goes through the browser-facing expectedRevision CAS, so a concurrent open
// browser cannot make orchestrated placement 409.

// Rune-weighted budget: 12 Han runes or roughly 24 Latin characters.
const autoGroupNameBudget = 24

// Orchestration guardrails. Depth counts ancestors; fan-out counts direct
// children still occupying an execution slot.
const (
	maxAgentSessionLineageDepth     = 4
	maxActiveAgentChildrenPerParent = 8
)

// ValidateParentSession resolves a create request's parent: it must be a
// visible session in the same workspace, unless crossWorkspace allows an agent
// to start work in another workspace its token reaches (the caller decides).
func (s *Store) ValidateParentSession(ctx context.Context, workspaceID, parentID string, crossWorkspace bool) (store.AgentSession, error) {
	parentID = strings.TrimSpace(parentID)
	if parentID == "" {
		return store.AgentSession{}, nil
	}
	parent, err := s.GetAgentSessionSummary(ctx, parentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, store.ErrNotFound) {
			return store.AgentSession{}, store.ErrSessionParentNotFound
		}
		return store.AgentSession{}, err
	}
	if parent.WorkspaceID != workspaceID && !crossWorkspace {
		return store.AgentSession{}, store.ErrSessionParentMismatch
	}
	return parent, nil
}

// PlaceChildWithParent applies the CHAT-01 grouping rule inside the caller's
// transaction. The bool reports whether a new group was created (so callers
// can trigger asynchronous naming).
func (s *Store) PlaceChildWithParent(ctx context.Context, parent store.AgentSession, childID string) (string, bool, error) {
	if strings.TrimSpace(parent.ID) == "" || strings.TrimSpace(childID) == "" {
		return "", false, errors.New("parent and child session ids are required")
	}
	layout, err := s.GetChatLayout(ctx, parent.WorkspaceID)
	if err != nil {
		return "", false, err
	}
	groupIDs := map[string]bool{}
	groupNames := map[string]bool{}
	for _, group := range layout.Groups {
		groupIDs[group.ID] = true
		groupNames[group.Name] = true
	}

	parentIndex := -1
	for i, position := range layout.Positions {
		if position.ChatID == parent.ID {
			parentIndex = i
			break
		}
	}

	targetGroupID := ""
	createdGroup := false
	if parentIndex >= 0 && strings.TrimSpace(layout.Positions[parentIndex].GroupID) != "" {
		targetGroupID = layout.Positions[parentIndex].GroupID
	} else {
		createdGroup = true
		targetGroupID = uuid.NewString()
		for groupIDs[targetGroupID] {
			targetGroupID = uuid.NewString()
		}
		name := uniqueAutoGroupName(autoGroupBaseName(parent.Title), groupNames)
		layout.Groups = append(layout.Groups, store.ChatLayoutGroup{ID: targetGroupID, Name: name})
		if parentIndex >= 0 {
			layout.Positions[parentIndex].GroupID = targetGroupID
		} else {
			layout.Positions = append(layout.Positions, store.ChatPlacement{ChatID: parent.ID, GroupID: targetGroupID})
		}
		layout.Positions = append(layout.Positions, store.ChatPlacement{ChatID: childID, GroupID: targetGroupID})
	}

	exists := false
	for _, position := range layout.Positions {
		if position.ChatID == childID {
			exists = true
			break
		}
	}
	if !exists && parentIndex >= 0 {
		// Append the child right after the parent so grouped siblings stay
		// adjacent in list order.
		insertAt := parentIndex + 1
		child := store.ChatPlacement{ChatID: childID, GroupID: targetGroupID}
		layout.Positions = append(layout.Positions[:insertAt], append([]store.ChatPlacement{child}, layout.Positions[insertAt:]...)...)
	}
	if err := s.persistLayout(ctx, parent.WorkspaceID, layout); err != nil {
		return "", false, err
	}
	return targetGroupID, createdGroup, nil
}

// persistLayout bumps the revision and writes the layout as server authority.
func (s *Store) persistLayout(ctx context.Context, workspaceID string, layout store.ChatLayout) error {
	layout.Revision++
	payload, err := json.Marshal(layout)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO chat_layouts(workspace_id, revision, payload_json) VALUES (?, ?, ?)
		ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json`,
		workspaceID, layout.Revision, string(payload))
	if err != nil {
		return fmt.Errorf("persist orchestrated chat layout: %w", err)
	}
	return nil
}

// SessionsInGroup lists positioned chat ids of one layout group, in list order.
func (s *Store) SessionsInGroup(ctx context.Context, workspaceID, groupID string) ([]string, error) {
	layout, err := s.GetChatLayout(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, position := range layout.Positions {
		if position.GroupID == groupID {
			ids = append(ids, position.ChatID)
		}
	}
	return ids, nil
}

// ListAgentSessionChildren returns the direct child sessions of one parent.
func (s *Store) ListAgentSessionChildren(ctx context.Context, workspaceID, parentID string) ([]store.AgentSession, error) {
	return listJSON[store.AgentSession](ctx, s.conn(), `SELECT json_set(json_remove(payload_json, '$.events', '$.response', '$.importedContext', '$.profileTransitionNote'), '$.lastActivityAt', updated_at)
		FROM agent_sessions
		WHERE workspace_id = ? AND parent_session_id = ? AND `+visibleAgentSessionSQL+`
		ORDER BY created_at ASC, id ASC LIMIT 200`, workspaceID, parentID)
}

// autoGroupBaseName derives a deterministic, LLM-free group name from the
// parent title: drop leading symbols, trim by runes, fall back to the default
// group name for placeholders.
func autoGroupBaseName(title string) string {
	base := strings.TrimSpace(strings.TrimLeftFunc(strings.TrimSpace(title), func(r rune) bool {
		return r == '*' || unicode.IsSymbol(r) || unicode.IsPunct(r)
	}))
	if base == "" || isPlaceholderChatTitle(base) {
		if writtenInChinese(base) {
			return "新建分组"
		}
		return "New group"
	}
	runes := []rune(base)
	used := 0
	for i, r := range runes {
		weight := 1
		if unicode.Is(unicode.Han, r) {
			weight = 2
		}
		if used+weight > autoGroupNameBudget {
			return strings.TrimSpace(string(runes[:i]))
		}
		used += weight
	}
	return base
}

func isPlaceholderChatTitle(title string) bool {
	placeholders := map[string]bool{
		"New chat":      true,
		"新聊天":           true,
		"新的聊天":          true,
		"新建聊天":          true,
		"Untitled":      true,
		"新对话":           true,
		"Codex session": true,
	}
	return placeholders[title]
}

func uniqueAutoGroupName(base string, taken map[string]bool) string {
	if !taken[base] {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s %d", base, suffix)
		if !taken[candidate] {
			return candidate
		}
	}
}

// SessionLineageDepth counts how many ancestors a session has (0 for a root
// session).
func (s *Store) SessionLineageDepth(ctx context.Context, sessionID string) (int, error) {
	var depth int
	err := s.conn().QueryRowContext(ctx, `WITH RECURSIVE lineage(id, depth) AS (
			SELECT ?, 0
			UNION ALL
			SELECT parent.parent_session_id, lineage.depth + 1
			FROM agent_sessions parent
			JOIN lineage ON parent.id = lineage.id
			WHERE parent.parent_session_id <> ''
		)
		SELECT MAX(depth) FROM lineage`, sessionID).Scan(&depth)
	if err != nil {
		return 0, err
	}
	return depth, nil
}

// CountActiveAgentChildren counts direct children that still occupy an
// execution slot (queued / running / blocked), in any workspace.
func (s *Store) CountActiveAgentChildren(ctx context.Context, parentID string) (int, error) {
	var count int
	err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_sessions
		WHERE parent_session_id = ?
			AND status IN ('queued', 'running', 'blocked')`,
		parentID).Scan(&count)
	return count, err
}
