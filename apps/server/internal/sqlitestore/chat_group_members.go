package sqlitestore

import (
	"context"
	"database/sql"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// chatListSessionSQL is the chat list's own rule for which sessions are chat
// rows (web isChatSession): the person's chats, and helper sessions no Issue
// owns. Naming, digest and other utility sessions never are.
var chatListSessionSQL = `(COALESCE(json_extract(agent_sessions.payload_json, '$.source'), '') IN ('', 'chat')
	OR (json_extract(agent_sessions.payload_json, '$.source') IN ` + store.AgentSessionSourcesSQL + ` AND COALESCE(json_extract(agent_sessions.payload_json, '$.issueId'), '') = ''))`

const (
	defaultChatGroupMemberLimit = 50
	maxChatGroupMemberLimit     = 100
)

// listableChatIDs is the set of chats the workspace's chat list can show:
// existing (not deleted), unarchived, and a chat row by its source. A
// folder's older row and the members it loads both come from this set, so a
// folder's own count and the archive dialog agree.
func (s *Store) listableChatIDs(ctx context.Context, workspaceID string) (map[string]bool, error) {
	ids := map[string]bool{}
	for _, query := range []string{
		`SELECT id FROM agent_sessions WHERE workspace_id=? AND ` + visibleAgentSessionSQL + ` AND NOT ` + archivedSessionSQL + ` AND ` + chatListSessionSQL,
		`SELECT id FROM chats WHERE workspace_id IN (?, '') AND ` + visibleChatSQL + ` AND NOT ` + archivedChatSQL,
	} {
		err := scanRows(ctx, s.reader(), query, func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids[id] = true
			return nil
		}, workspaceID)
		if err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// ChatGroupMemberCounts counts each folder's listable chats. The chat list
// shows only its newest 80 sessions, so a folder can hold more than it draws;
// this count lets it say how many it has not drawn yet.
func (s *Store) ChatGroupMemberCounts(ctx context.Context, workspaceID string) (map[string]int, error) {
	layout, err := s.GetChatLayout(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	listable, err := s.listableChatIDs(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, position := range layout.Positions {
		if position.GroupID != "" && listable[position.ChatID] {
			counts[position.GroupID]++
		}
	}
	return counts, nil
}

// ListChatGroupMemberSessions reads one page of a folder's listable sessions,
// newest activity first, with the same cursor order the session list uses. It
// returns the cursor that reads the next page; empty on the last one.
func (s *Store) ListChatGroupMemberSessions(ctx context.Context, workspaceID, groupID, cursor string, limit int) ([]store.AgentSession, string, error) {
	layout, err := s.GetChatLayout(ctx, workspaceID)
	if err != nil {
		return nil, "", err
	}
	found := false
	for _, group := range layout.Groups {
		if group.ID == groupID {
			found = true
		}
	}
	if !found {
		return nil, "", store.ErrNotFound
	}
	listable, err := s.listableChatIDs(ctx, workspaceID)
	if err != nil {
		return nil, "", err
	}
	ids := []string{}
	for _, position := range layout.Positions {
		if position.GroupID == groupID && listable[position.ChatID] {
			ids = append(ids, position.ChatID)
		}
	}
	if len(ids) == 0 {
		return []store.AgentSession{}, "", nil
	}
	if limit <= 0 {
		limit = defaultChatGroupMemberLimit
	}
	limit = min(limit, maxChatGroupMemberLimit)
	where := []string{
		`agent_sessions.workspace_id = ?`,
		`agent_sessions.id IN (?` + strings.Repeat(",?", len(ids)-1) + `)`,
		visibleAgentSessionSQL,
	}
	args := []any{workspaceID}
	for _, id := range ids {
		args = append(args, id)
	}
	if cursor != "" {
		activity, id, err := decodeSessionListCursor(cursor)
		if err != nil {
			return nil, "", err
		}
		where = append(where, `(agent_sessions.activity_at < ? OR (agent_sessions.activity_at = ? AND agent_sessions.id < ?))`)
		args = append(args, activity, activity, id)
	}
	args = append(args, limit+1)
	sessions, err := listJSON[store.AgentSession](ctx, s.reader(), `SELECT `+agentSessionSlimSQL+`
		FROM agent_sessions WHERE `+strings.Join(where, " AND ")+`
		ORDER BY agent_sessions.activity_at DESC, agent_sessions.id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(sessions) > limit {
		sessions = sessions[:limit]
		last := sessions[limit-1]
		next = encodeSessionListCursor(last.ActivityAt, last.ID)
	}
	return sessions, next, nil
}

var _ store.ChatGroupMemberStore = (*Store)(nil)
