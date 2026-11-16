package sqlitestore

import (
	"context"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// retiredUpkeepNoticeMigration names the recorded migration; version 1 is the
// classification below. A later version runs it again.
const (
	retiredUpkeepNoticeMigration = "retired-upkeep-notices"
	retiredUpkeepNoticeVersion   = 1
)

// retiredUpkeepNoticeCutoff is when the DEV-252 deploy stopped the upkeep
// notices (08:10 UTC; the last one sent before it was at 07:41). It is
// compared with created_at's first 19 characters, the UTC time to the second,
// so no date parsing is involved and the cutoff second itself is excluded.
const retiredUpkeepNoticeCutoff = "2026-11-16T08:10:00"

// retiredUpkeepNoticePrefixes open the prompts DEV-238 gave the upkeep
// notices: "[Foundry] " plus the first line maintenance.go built, in
// Chinese and English. Only a prompt starting with one of them matches.
var retiredUpkeepNoticePrefixes = []string{
	"[Foundry] 项目维护：",
	"[Foundry] 项目摘要：",
	"[Foundry] Project upkeep:",
	"[Foundry] Project summaries:",
}

// retiredUpkeepHomeSources are the sources store.Conversation excludes; with
// the role, parent and owner checks they make the session an assistant's home
// conversation.
var retiredUpkeepHomeSources = store.SQLStringList(
	append([]string{store.SessionSourceAgent, store.SessionSourceVerification}, store.UtilitySessionSources...)...)

// migrateRetiredUpkeepNotices runs the recorded marking once per database
// (DEV-260). A database that already has the record skips it.
func (s *Store) migrateRetiredUpkeepNotices(ctx context.Context) error {
	return s.runDataMigration(ctx, retiredUpkeepNoticeMigration, retiredUpkeepNoticeVersion, func(tx *Store) error {
		return tx.markRetiredUpkeepNotices(ctx)
	})
}

// markRetiredUpkeepNotices sets the structured source noticeKind "upkeep" on
// the upkeep notices DEV-238 sent before DEV-252 stopped them. A row matches
// only when all of these hold:
//   - it is a user input whose prompt opens with a retired upkeep prefix;
//   - its source is foundry_notice with no noticeKind yet, or it has no source
//     at all (inputs from before DEV-246);
//   - it was created before the cutoff;
//   - its session is an assistant's home conversation: the session's workspace
//     is the home of an assistant owned by the session's creator, and the
//     session is one the person started there (no parent, no excluded source,
//     no role other than a conversation's).
//
// The source is merged in with json_patch, so the event's other fields stay.
// Events are updated in place, never deleted. The migration runs once (see
// runDataMigration), so the rows it updates are never revisited.
func (s *Store) markRetiredUpkeepNotices(ctx context.Context) error {
	args := []any{store.NoticeKindUpkeep, retiredUpkeepNoticeCutoff}
	prefixMatches := make([]string, 0, len(retiredUpkeepNoticePrefixes))
	for _, prefix := range retiredUpkeepNoticePrefixes {
		prefixMatches = append(prefixMatches, "instr(json_extract(payload_json, '$.message.text'), ?) = 1")
		args = append(args, prefix)
	}
	query := `UPDATE agent_session_events
		SET payload_json = json_patch(payload_json, json_object('metadata', json_object('inputSource',
			json_object('kind', 'foundry_notice', 'noticeKind', ?))))
		WHERE json_extract(payload_json, '$.message.kind') = 'user'
		  AND json_extract(payload_json, '$.metadata.inputSource.noticeKind') IS NULL
		  AND (json_extract(payload_json, '$.metadata.inputSource.kind') = 'foundry_notice'
		       OR json_type(payload_json, '$.metadata.inputSource') IS NULL)
		  AND substr(created_at, 1, 19) < ?
		  AND (` + strings.Join(prefixMatches, " OR ") + `)
		  AND EXISTS (
			SELECT 1 FROM agent_sessions s
			JOIN assistants a ON a.home_workspace_id = s.workspace_id
				AND a.owner_user_id = json_extract(s.payload_json, '$.createdByUserId')
			WHERE s.id = agent_session_events.session_id
			  AND COALESCE(json_extract(s.payload_json, '$.role'), '') IN ('', '` + store.AgentSessionRolePersonalAgent + `')
			  AND s.parent_session_id = ''
			  AND COALESCE(json_extract(s.payload_json, '$.createdByUserId'), '') <> ''
			  AND COALESCE(json_extract(s.payload_json, '$.source'), '') NOT IN ` + retiredUpkeepHomeSources + `)`
	if _, err := s.conn().ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("mark retired upkeep notices: %w", err)
	}
	return nil
}
