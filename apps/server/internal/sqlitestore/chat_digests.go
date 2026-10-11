package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ChatDigests lists the native chats a workspace's device synced, each as
// the fields a worker compares with its own copy. Transcripts are counted
// in SQLite, never decoded here.
func (s *Store) ChatDigests(ctx context.Context, workspaceID string) ([]store.ChatDigest, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT id,
		COALESCE(json_extract(payload_json, '$.updatedAt'), ''),
		COALESCE(json_extract(payload_json, '$.status'), ''),
		COALESCE(json_extract(payload_json, '$.answerRevision'), ''),
		COALESCE(json_extract(payload_json, '$.title'), ''),
		COALESCE(json_extract(payload_json, '$.preview'), ''),
		COALESCE(json_array_length(payload_json, '$.transcript'), 0)
		FROM chats WHERE workspace_id = ? AND native_session_id != '' ORDER BY id`,
		strings.TrimSpace(workspaceID))
	if err != nil {
		return nil, fmt.Errorf("list chat digests: %w", err)
	}
	defer rows.Close()
	digests := []store.ChatDigest{}
	for rows.Next() {
		var digest store.ChatDigest
		var transcript sql.NullInt64
		if err := rows.Scan(&digest.ID, &digest.UpdatedAt, &digest.Status, &digest.AnswerRevision,
			&digest.Title, &digest.Preview, &transcript); err != nil {
			return nil, fmt.Errorf("read chat digest: %w", err)
		}
		digest.TranscriptMessages = int(transcript.Int64)
		digests = append(digests, digest)
	}
	return digests, rows.Err()
}
