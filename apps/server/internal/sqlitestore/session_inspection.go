package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.SessionInspectionStore = (*Store)(nil)

func (s *Store) AgentSessionCreatedAt(ctx context.Context, sessionID string) (string, error) {
	var createdAt string
	err := s.conn().QueryRowContext(ctx, `SELECT created_at FROM agent_sessions WHERE id = ? AND `+visibleAgentSessionSQL, sessionID).Scan(&createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	return createdAt, err
}

func (s *Store) NativeSessionOwner(ctx context.Context, provider, nativeID string) (string, error) {
	return s.nativeSessionOwner(ctx, provider, nativeID)
}

const (
	defaultSessionListLimit = 30
	maxSessionListLimit     = 100
)

// ListSessionPage reads only the columns a list shows. Every filter applies
// in SQL before the limit, so a page is never short because of what a later
// filter would drop; the cursor is the last row's (activity_at, id), the
// list's own order.
func (s *Store) ListSessionPage(ctx context.Context, query store.SessionListQuery) (store.SessionListPage, error) {
	var page store.SessionListPage
	where := []string{`agent_sessions.workspace_id = ?`,
		`COALESCE(json_extract(agent_sessions.payload_json, '$.source'), '') NOT IN ('naming', 'digest')`,
		visibleAgentSessionSQL}
	args := []any{strings.TrimSpace(query.WorkspaceID)}
	if parent := strings.TrimSpace(query.ParentSessionID); parent != "" {
		where = append(where, `agent_sessions.parent_session_id = ?`)
		args = append(args, parent)
	}
	limit := query.Limit
	if query.IDs != nil {
		if len(query.IDs) == 0 {
			page.Sessions = []store.SessionListItem{}
			return page, nil
		}
		where = append(where, `agent_sessions.id IN (?`+strings.Repeat(",?", len(query.IDs)-1)+`)`)
		for _, id := range query.IDs {
			args = append(args, id)
		}
		limit = len(query.IDs)
	} else {
		if limit <= 0 {
			limit = defaultSessionListLimit
		}
		limit = min(limit, maxSessionListLimit)
		if cursor := strings.TrimSpace(query.Cursor); cursor != "" {
			activity, id, err := decodeSessionListCursor(cursor)
			if err != nil {
				return page, err
			}
			where = append(where, `(agent_sessions.activity_at < ? OR (agent_sessions.activity_at = ? AND agent_sessions.id < ?))`)
			args = append(args, activity, activity, id)
		}
	}
	args = append(args, limit+1)
	page.Sessions = []store.SessionListItem{}
	err := scanRows(ctx, s.reader(), `SELECT agent_sessions.id, agent_sessions.workspace_id, agent_sessions.device_id,
			agent_sessions.provider, agent_sessions.status, agent_sessions.parent_session_id, agent_sessions.activity_at,
			COALESCE(NULLIF(title.title, ''), json_extract(agent_sessions.payload_json, '$.title'), ''),
			COALESCE(json_extract(agent_sessions.payload_json, '$.profileId'), ''),
			COALESCE(json_extract(agent_sessions.payload_json, '$.profileLabel'), ''),
			COALESCE(json_extract(agent_sessions.payload_json, '$.issueId'), ''),
			COALESCE(json_extract(agent_sessions.payload_json, '$.role'), ''),
			COALESCE(json_extract(agent_sessions.payload_json, '$.source'), '')
		FROM agent_sessions
		LEFT JOIN chat_titles AS title ON title.workspace_id = agent_sessions.workspace_id AND title.chat_id = agent_sessions.id
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY agent_sessions.activity_at DESC, agent_sessions.id DESC LIMIT ?`, func(rows *sql.Rows) error {
		var item store.SessionListItem
		if err := rows.Scan(&item.ID, &item.WorkspaceID, &item.DeviceID, &item.Provider, &item.Status, &item.ParentSessionID,
			&item.ActivityAt, &item.Title, &item.ProfileID, &item.ProfileLabel, &item.IssueID, &item.Role, &item.Source); err != nil {
			return err
		}
		page.Sessions = append(page.Sessions, item)
		return nil
	}, args...)
	if err != nil {
		return store.SessionListPage{}, err
	}
	if len(page.Sessions) > limit {
		page.Sessions = page.Sessions[:limit]
		last := page.Sessions[limit-1]
		page.NextCursor = encodeSessionListCursor(last.ActivityAt, last.ID)
	}
	return page, nil
}

func encodeSessionListCursor(activity, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(activity + "\n" + id))
}

func decodeSessionListCursor(cursor string) (string, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", store.ErrSessionListCursor
	}
	activity, id, ok := strings.Cut(string(raw), "\n")
	if !ok || id == "" {
		return "", "", store.ErrSessionListCursor
	}
	return activity, id, nil
}
