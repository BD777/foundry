package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const archivedSessionSQL = `EXISTS (SELECT 1 FROM chat_archives a WHERE a.workspace_id=agent_sessions.workspace_id AND a.archive_key IN ('id:'||agent_sessions.id,'id:'||agent_sessions.thread_id,'native:'||agent_sessions.provider||':'||json_extract(agent_sessions.payload_json,'$.nativeSessionId')))`
const archivedChatSQL = `EXISTS (SELECT 1 FROM chat_archives a WHERE a.workspace_id=chats.workspace_id AND a.archive_key IN ('id:'||chats.id,'native:'||chats.provider||':'||chats.native_session_id))`

func archiveFilter(expr, mode string) string {
	switch mode {
	case "include":
		return "1"
	case "only":
		return expr
	default:
		return "NOT " + expr
	}
}
func (s *Store) archiveInfo(ctx context.Context, ws, id, provider, native string) (store.ChatArchive, error) {
	var a store.ChatArchive
	err := s.reader().QueryRowContext(ctx, `SELECT archived_at,archived_by_user,archived_by_session,batch_id FROM chat_archives WHERE workspace_id=? AND archive_key IN (?,?) ORDER BY archived_at LIMIT 1`, ws, "id:"+id, "native:"+provider+":"+native).Scan(&a.ArchivedAt, &a.ArchivedByUser, &a.ArchivedBySession, &a.ArchiveBatchID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return a, err
	}
	a.NativeArchive, err = listJSON[store.NativeArchiveTarget](ctx, s.reader(), `SELECT payload_json FROM native_archive_targets WHERE workspace_id=? AND (session_id=? OR (provider=? AND native_id=?)) ORDER BY provider,native_id,device_id`, ws, id, provider, native)

	if err != nil {
		return a, err
	}
	if a.ArchivedByUser != "" {
		if user, e := s.GetUser(ctx, a.ArchivedByUser); e == nil {
			a.ArchivedByLabel = user.DisplayName
			if a.ArchivedByLabel == "" {
				a.ArchivedByLabel = user.Username
			}
		}
	}
	if a.ArchivedBySession != "" {
		_ = s.reader().QueryRowContext(ctx, `SELECT COALESCE(NULLIF((SELECT title FROM chat_titles WHERE workspace_id=?1 AND chat_id=?2),''),json_extract(payload_json,'$.title'),'') FROM agent_sessions WHERE workspace_id=?1 AND id=?2`, ws, a.ArchivedBySession).Scan(&a.ArchivedByLabel)
	}
	for i := range a.NativeArchive {
		_ = s.reader().QueryRowContext(ctx, `SELECT COALESCE((SELECT name FROM device_display_names WHERE device_id=devices.id),json_extract(payload_json,'$.label'),'') FROM devices WHERE id=?`, a.NativeArchive[i].DeviceID).Scan(&a.NativeArchive[i].DeviceLabel)
	}
	return a, nil
}
func (s *Store) attachArchiveSession(ctx context.Context, v *store.AgentSession) error {
	a, e := s.archiveInfo(ctx, v.WorkspaceID, v.ID, v.Provider, v.NativeSessionID)
	v.ChatArchive = a
	return e
}
func (s *Store) attachArchiveChat(ctx context.Context, v *store.ChatThread) error {
	a, e := s.archiveInfo(ctx, v.WorkspaceID, v.ID, v.Provider, v.NativeSessionID)
	v.ChatArchive = a
	v.Archived = a.ArchivedAt != ""
	return e
}
func (s *Store) requireActiveChat(ctx context.Context, ws, id string) error {
	var archived bool
	err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM chat_archives WHERE workspace_id=?1 AND (archive_key='id:'||?2 OR archive_key IN (
 SELECT 'native:'||provider||':'||native_session_id FROM chats WHERE id=?2 AND workspace_id=?1
 UNION SELECT 'native:'||provider||':'||native_id FROM agent_session_native_ids WHERE session_id=?2)))`, ws, id).Scan(&archived)
	if err != nil {
		return err
	}
	if archived {
		return store.ErrSessionArchived
	}
	return nil
}
func (s *Store) ListArchivedChats(ctx context.Context, ws, mode string) ([]store.ChatThread, error) {
	q := `SELECT json_remove(payload_json,'$.handoffContext','$.recentMessages','$.transcript') FROM chats WHERE ` + visibleChatSQL + ` AND NOT ` + nativeClaimedSQL + ` AND ` + archiveFilter(archivedChatSQL, mode)
	args := []any{}
	if ws != "" {
		q += ` AND workspace_id IN (?, '')`
		args = append(args, ws)
	}
	values, err := listJSON[store.ChatThread](ctx, s.reader(), q+` ORDER BY activity_at DESC,id`, args...)
	if err != nil {
		return nil, err
	}
	for i := range values {
		if err = s.attachArchiveChat(ctx, &values[i]); err != nil {
			return nil, err
		}
	}
	return values, nil
}
func (s *Store) ListArchivedSessions(ctx context.Context, ws, mode string) ([]store.AgentSession, error) {
	q := `SELECT json_set(json_remove(payload_json,'$.events','$.response','$.input.importedContext','$.input.profileTransitionNote'),'$.lastActivityAt',updated_at) FROM agent_sessions WHERE ` + visibleAgentSessionSQL + ` AND (COALESCE(json_extract(payload_json,'$.source'),'') NOT IN ('naming','digest') OR status IN ('queued','running')) AND ` + archiveFilter(archivedSessionSQL, mode)
	args := []any{}
	if ws != "" {
		q += ` AND workspace_id=?`
		args = append(args, ws)
	}
	q += ` ORDER BY activity_at DESC,id DESC`
	if mode == "exclude" || mode == "" {
		q += ` LIMIT 80`
	}
	values, err := listJSON[store.AgentSession](ctx, s.reader(), q, args...)
	if err != nil {
		return nil, err
	}
	for i := range values {
		if err = s.attachArchiveSession(ctx, &values[i]); err != nil {
			return nil, err
		}
	}
	return values, nil
}

// Resolving IDs in the store and rechecking in the write transaction prevents a
// client-side filtered list from making a partial folder archive.
func (s *Store) ArchiveChatIDs(ctx context.Context, input store.ArchiveChatsInput) ([]string, error) {
	if input.WorkspaceID == "" {
		return nil, store.ErrInvalidArchive
	}
	n := 0
	if len(input.ChatIDs) > 0 {
		n++
	}
	if input.GroupID != "" {
		n++
	}
	if input.BatchID != "" {
		n++
	}
	if n != 1 {
		return nil, store.ErrInvalidArchive
	}
	if _, err := s.GetWorkspace(ctx, input.WorkspaceID); err != nil {
		return nil, err
	}
	ids := slices.Clone(input.ChatIDs)
	if input.GroupID != "" {
		layout, err := s.GetChatLayout(ctx, input.WorkspaceID)
		if err != nil {
			return nil, err
		}
		found := false
		for _, g := range layout.Groups {
			if g.ID == input.GroupID {
				found = true
			}
		}
		if !found {
			return nil, store.ErrNotFound
		}
		for _, p := range layout.Positions {
			if p.GroupID == input.GroupID {
				ids = append(ids, p.ChatID)
			}
		}
	}
	if input.BatchID != "" {
		var err error
		ids, err = listStrings(ctx, s.conn(), `SELECT substr(archive_key,4) FROM chat_archives WHERE workspace_id=? AND batch_id=? AND archive_key LIKE 'id:%' ORDER BY archive_key`, input.WorkspaceID, input.BatchID)
		if err != nil {
			return nil, err
		}
	}
	result := []string{}
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(result, id) {
			result = append(result, id)
		}
	}
	if len(result) > 1000 {
		return nil, store.ErrInvalidArchive
	}
	return result, nil
}

type archiveSubject struct {
	id      string
	session *store.AgentSession
	chat    *store.ChatThread
	keys    []string
}

func (s *Store) archiveSubject(ctx context.Context, ws, id string) (archiveSubject, error) {
	v := archiveSubject{id: id, keys: []string{"id:" + id}}
	session, err := s.GetAgentSessionRecord(ctx, id)
	if err == nil {
		if session.WorkspaceID != ws {
			return v, store.ErrNotFound
		}
		v.session = &session
		v.keys = append(v.keys, "id:"+session.ThreadID)
		keys, e := s.nativeDeletionKeys(ctx, []string{id})
		if e != nil {
			return v, e
		}
		v.keys = append(v.keys, keys...)
		if session.NativeSessionID != "" {
			v.keys = append(v.keys, "native:"+session.Provider+":"+session.NativeSessionID)
		}
		if session.AdoptedChatID != "" {
			v.keys = append(v.keys, "id:"+session.AdoptedChatID)
		}
		return v, nil
	}
	if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, sql.ErrNoRows) {
		return v, err
	}
	chat, err := s.GetChat(ctx, id)
	if err != nil {
		return v, err
	}
	if chat.WorkspaceID != ws {
		return v, store.ErrNotFound
	}
	v.chat = &chat
	if chat.NativeSessionID != "" {
		v.keys = append(v.keys, "native:"+chat.Provider+":"+chat.NativeSessionID)
	}
	return v, nil
}
func archiveWorkBlocker(sessionID string, w store.SessionWork, code, reason string) store.ArchiveBlocker {
	b := store.ArchiveBlocker{ID: sessionID, Reason: reason, Code: code, WorkTitle: w.Title, WorkID: w.ID, WorkSessionID: w.SessionID, WorkRevision: w.Revision, WorkReferenceRevision: w.ReferenceRevision}
	if slices.Contains(w.AllowedActions, "stop") {
		b.Action = "stop_work"
	} else if slices.Contains(w.AllowedActions, "unlink") && slices.Contains(w.RelatedSessionIDs, sessionID) {
		b.Action = "unlink_work"
	}
	return b
}

func (s *Store) ArchiveChats(ctx context.Context, input store.ArchiveChatsInput, restore bool) (store.ArchiveChatsResult, error) {
	result := store.ArchiveChatsResult{Archived: []string{}, Blockers: []store.ArchiveBlocker{}, PausedWork: []store.ArchivePausedWork{}}
	err := s.withTx(ctx, func(tx *Store) error {
		ids, err := tx.ArchiveChatIDs(ctx, input)
		if err != nil {
			return err
		}
		if input.ExpectedChatIDs != nil && !slices.Equal(input.ExpectedChatIDs, ids) {
			return store.ErrChatLayoutConflict
		}
		subjects := []archiveSubject{}
		seenWork := map[string]bool{}
		for _, id := range ids {
			subject, e := tx.archiveSubject(ctx, input.WorkspaceID, id)
			// Historical unknown placements are retained and get archive markers too.
			if e != nil && !errors.Is(e, store.ErrNotFound) && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			if e != nil && input.GroupID == "" && input.BatchID == "" {
				return store.ErrNotFound
			}
			if subject.session != nil && !restore {
				v := subject.session
				reason, code := "", ""
				switch {
				case v.Status == "queued" || v.Status == "running":
					reason, code = "Stop it first", "running"
				case v.Role == store.AgentSessionRolePersonalAgent:
					reason, code = "Personal Agent home conversation cannot be archived", "personal_agent"
				case v.IssueID != "" || v.Role != "":
					reason, code = "managed by Issue "+v.IssueID, "issue_owned"
				}
				if reason != "" {
					blocker := store.ArchiveBlocker{ID: id, Reason: reason, Code: code, IssueID: v.IssueID}
					if code == "running" {
						blocker.Action = "stop_session"
					} else if input.GroupID != "" {
						blocker.Action = "remove_from_folder"
					}
					result.Blockers = append(result.Blockers, blocker)
				}
				work, e := tx.listSessionWork(ctx, id, "", false)
				if e != nil {
					return e
				}
				for _, w := range work.Items {
					// Native subagents and unified-exec terminals belong to this
					// session runtime. Stale observations cannot outlive an idle
					// owner and must never be paused, stopped, or block archive.
					if w.Management == "observed" && (w.Source == "claude" || w.Source == "codex") && v.Status != "running" && v.Status != "queued" {
						continue
					}
					// Foundry child sessions remain independent of their parent.
					if w.Kind != "process" && w.Kind != "schedule" {
						continue
					}
					if w.DesiredState != "enabled" || !store.StandaloneSessionWork(w) || confirmedWorkEnded(w) || seenWork[w.ID] {
						continue
					}

					// A host inventory scan can be attributed to this
					// conversation without ownership of the system schedule.
					// Archive never adopts or stops unrelated observed work.
					if w.Management != "managed" && w.Native == nil {
						continue
					}
					seenWork[w.ID] = true
					if w.Management != "managed" || !slices.Contains(w.AllowedActions, "pause") {
						result.Blockers = append(result.Blockers, archiveWorkBlocker(id, w, "work_unpausable", "Stop work first: "+w.Title))
						continue
					}
					// Shared services cannot be paused as a side effect of one chat.
					if len(w.RelatedSessionIDs) > 0 {
						result.Blockers = append(result.Blockers, archiveWorkBlocker(id, w, "work_shared", "Stop or unlink shared work first: "+w.Title))
						continue
					}
					result.PausedWork = append(result.PausedWork, store.ArchivePausedWork{ID: w.ID, Title: w.Title, SessionID: id})
				}
			}
			if subject.chat != nil && !restore && (subject.chat.Status == "running" || subject.chat.Status == "queued") {
				result.Blockers = append(result.Blockers, store.ArchiveBlocker{ID: id, Reason: "Stop it first", Code: "running", Action: "stop_session"})
			}
			subjects = append(subjects, subject)
			result.Archived = append(result.Archived, id)
		}
		if input.DryRun {
			return nil
		}
		if len(result.Blockers) > 0 {
			return store.ErrArchiveBlocked
		}
		now := formatTime(time.Now().UTC())
		batch := input.BatchID
		if batch == "" {
			batch = "arch_" + newSessionInputID(time.Now().UTC())
		}
		result.BatchID = batch
		audit, err := json.Marshal(result)
		if err != nil {
			return err
		}
		if _, err = tx.conn().ExecContext(ctx, `INSERT INTO chat_archive_events(id,workspace_id,at,actor_user,actor_session,restored,payload_json) VALUES(?,?,?,?,?,?,?)`, "archive_evt_"+newSessionInputID(time.Now().UTC()), input.WorkspaceID, now, input.ArchivedByUser, input.ArchivedBySession, restore, string(audit)); err != nil {
			return err
		}

		for _, v := range subjects {
			if restore {
				// Remove every alias of the same item, but never restore other items
				// that merely shared an archive batch.
				keys := slices.Clone(v.keys)
				if v.session != nil {
					keys = append(keys, "id:"+v.session.ID)
				}
				for _, key := range keys {
					if _, err = tx.conn().ExecContext(ctx, `DELETE FROM chat_archives WHERE workspace_id=? AND archive_key=?`, input.WorkspaceID, key); err != nil {
						return err
					}
				}
			} else {
				for _, key := range v.keys {
					if _, err = tx.conn().ExecContext(ctx, `INSERT INTO chat_archives(workspace_id,archive_key,archived_at,archived_by_user,archived_by_session,batch_id) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,archive_key) DO NOTHING`, input.WorkspaceID, key, now, input.ArchivedByUser, input.ArchivedBySession, batch); err != nil {
						return err
					}
				}
			}
			if err = tx.archiveNativeSubject(ctx, input.WorkspaceID, v, restore); err != nil {
				return err
			}
		}
		if !restore {
			var busy bool
			if err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE workspace_id=? AND status IN ('queued','running') AND `+archivedSessionSQL+`)`, input.WorkspaceID).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return store.ErrArchiveBlocked
			}
		}
		for _, w := range result.PausedWork {
			listed, e := tx.listSessionWork(ctx, w.SessionID, "", false)
			if e != nil {
				return e
			}
			for _, item := range listed.Items {
				if item.ID == w.ID {
					_, e = tx.ControlSessionWork(ctx, w.SessionID, w.SessionID, store.WorkControlInput{ID: w.ID, Action: "pause", ExpectedRevision: item.Revision, ExpectedReferenceRevision: item.ReferenceRevision, IdempotencyKey: batch + ":" + item.ID})
					if e != nil {
						return e
					}
				}
			}
		}
		layout, e := tx.GetChatLayout(ctx, input.WorkspaceID)
		if e != nil {
			return e
		}
		changed := false
		for i, g := range layout.Groups {
			if !restore && g.ID == input.GroupID {
				layout.Groups[i].ArchivedAt = now
				layout.Groups[i].ArchiveBatchID = batch
				changed = true
			}
			if restore && (g.ID == input.GroupID || (input.BatchID != "" && g.ArchiveBatchID == input.BatchID)) {
				layout.Groups[i].ArchivedAt = ""
				layout.Groups[i].ArchiveBatchID = ""
				changed = true
			}
			if restore && g.ArchivedAt != "" {
				for _, p := range layout.Positions {
					if p.GroupID == g.ID && slices.Contains(ids, p.ChatID) {
						layout.Groups[i].ArchivedAt = ""
						layout.Groups[i].ArchiveBatchID = ""
						changed = true
						break
					}
				}
			}
		}
		if changed {
			_, err = tx.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: input.WorkspaceID, ExpectedRevision: &layout.Revision, Layout: layout})
			if err != nil {
				return err
			}
		}
		return nil
	})
	return result, err
}

// Scanner state mirrors native-only chats; a pending command wins over a stale
// scan. Owned sessions are filtered by claimNativeChat before this is called.
func (s *Store) recordNativeChatArchiveObservation(ctx context.Context, v store.ChatThread) error {
	if v.NativeSessionID == "" {
		return nil
	}
	target, err := listJSON[store.NativeArchiveTarget](ctx, s.conn(), `SELECT payload_json FROM native_archive_targets WHERE workspace_id=? AND provider=? AND native_id=?`, v.WorkspaceID, v.Provider, v.NativeSessionID)
	if err != nil {
		return err
	}
	for _, t := range target {
		if t.State == "pending" || t.State == "failed" || t.State == "unsupported" {
			return nil
		}
	}
	key := "native:" + v.Provider + ":" + v.NativeSessionID
	if v.Archived {
		_, err = s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO chat_archives(workspace_id,archive_key,archived_at,batch_id) VALUES(?,?,?,?)`, v.WorkspaceID, key, formatTime(time.Now().UTC()), "native:"+v.ID)
	} else {
		_, err = s.conn().ExecContext(ctx, `DELETE FROM chat_archives WHERE workspace_id=? AND archive_key IN (?,?)`, v.WorkspaceID, key, "id:"+v.ID)
	}
	return err
}

var _ store.ChatArchiveStore = (*Store)(nil)
