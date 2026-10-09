package sqlitestore

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Foundry session owns the native Claude Code and Codex sessions it runs
// on. On each runtime (a provider on a device) it has one current native
// session, which it resumes whenever it runs there again; one it can no
// longer resume is retired. Every native session it ever ran stays claimed
// by it: the device's own record of that session is not listed as another
// chat, its usage is the session's, and it goes when the session goes.
//
// This file alone writes agent_session_native_ids and the session's
// nativeSessionId / forkNativeSessionId projection.

func nativeSessionSchema() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS agent_session_native_ids (
			provider TEXT NOT NULL,
			native_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			device_id TEXT NOT NULL DEFAULT '',
			current INTEGER NOT NULL DEFAULT 0,
			last_input_id TEXT NOT NULL DEFAULT '',
			attached_at TEXT NOT NULL,
			PRIMARY KEY (provider, native_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_agent_session_native_ids_session ON agent_session_native_ids (session_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_native_ids_current
			ON agent_session_native_ids (session_id, provider, device_id) WHERE current = 1`,
	}
}

// nativeRuntime is where a native session lives: its provider's records on
// one device.
type nativeRuntime struct {
	provider string
	deviceID string
}

func sessionRuntime(session store.AgentSession) nativeRuntime {
	return nativeRuntime{provider: session.Provider, deviceID: session.DeviceID}
}

// nativeClaimedSQL is true for a chats row whose native session a Foundry
// session owns.
const nativeClaimedSQL = `EXISTS (SELECT 1 FROM agent_session_native_ids n
	WHERE n.provider = chats.provider AND n.native_id = chats.native_session_id)`

type nativeSessionRow struct {
	nativeID    string
	lastInputID string
}

func (s *Store) currentNativeSession(ctx context.Context, sessionID string, runtime nativeRuntime) (nativeSessionRow, bool, error) {
	var row nativeSessionRow
	err := s.conn().QueryRowContext(ctx, `SELECT native_id, last_input_id FROM agent_session_native_ids
		WHERE session_id = ? AND provider = ? AND device_id = ? AND current = 1`,
		sessionID, runtime.provider, runtime.deviceID).Scan(&row.nativeID, &row.lastInputID)
	if errors.Is(err, sql.ErrNoRows) {
		return nativeSessionRow{}, false, nil
	}
	return row, err == nil, err
}

// nativeSessionOwner names the Foundry session that owns a native session.
func (s *Store) nativeSessionOwner(ctx context.Context, provider, nativeID string) (string, error) {
	var owner string
	err := s.conn().QueryRowContext(ctx, `SELECT session_id FROM agent_session_native_ids WHERE provider = ? AND native_id = ?`,
		strings.TrimSpace(provider), strings.TrimSpace(nativeID)).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return owner, err
}

// claimNativeSession records a native session as the session's on a
// runtime: current (the one it resumes there) or retired. A native session
// owned by another Foundry session stays with its owner. The device's own
// record of it leaves the chat list in the same write.
func (s *Store) claimNativeSession(ctx context.Context, sessionID string, runtime nativeRuntime, nativeID, inputID string, current bool) (bool, error) {
	nativeID = strings.TrimSpace(nativeID)
	if nativeID == "" || runtime.provider == "" {
		return false, nil
	}
	owner, err := s.nativeSessionOwner(ctx, runtime.provider, nativeID)
	if err != nil {
		return false, err
	}
	if owner != "" && owner != sessionID {
		return false, nil
	}
	if current {
		if _, err := s.conn().ExecContext(ctx, `UPDATE agent_session_native_ids SET current = 0
			WHERE session_id = ? AND provider = ? AND device_id = ? AND current = 1 AND native_id <> ?`,
			sessionID, runtime.provider, runtime.deviceID, nativeID); err != nil {
			return false, fmt.Errorf("retire native session: %w", err)
		}
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO agent_session_native_ids
		(provider, native_id, session_id, device_id, current, last_input_id, attached_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, native_id) DO UPDATE SET
			current = MAX(agent_session_native_ids.current, excluded.current),
			device_id = CASE WHEN excluded.current = 1 THEN excluded.device_id ELSE agent_session_native_ids.device_id END,
			last_input_id = CASE WHEN excluded.last_input_id <> '' THEN excluded.last_input_id ELSE agent_session_native_ids.last_input_id END
		WHERE agent_session_native_ids.session_id = excluded.session_id`,
		runtime.provider, nativeID, sessionID, runtime.deviceID, boolInt(current), inputID, formatTime(time.Now())); err != nil {
		return false, fmt.Errorf("claim native session: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM chats WHERE provider = ? AND native_session_id = ?`, runtime.provider, nativeID); err != nil {
		return false, fmt.Errorf("remove claimed native chat: %w", err)
	}
	return true, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// attachNativeSession makes nativeID the session's current native session on
// the runtime it runs on, the one that ran inputID. Callers save the session.
func (s *Store) attachNativeSession(ctx context.Context, session *store.AgentSession, nativeID, inputID string) error {
	claimed, err := s.claimNativeSession(ctx, session.ID, sessionRuntime(*session), nativeID, inputID, true)
	if err != nil || !claimed {
		return err
	}
	session.NativeSessionID = strings.TrimSpace(nativeID)
	return nil
}

// settleNativeFork ends a fork once the forked native session has answered:
// from then on it is resumed like any other.
func settleNativeFork(session *store.AgentSession) {
	session.ForkNativeSessionID = ""
}

// pointAtNativeSession sets the session's native session to its current one
// on the runtime it runs on now. A fork that has not answered keeps its
// source while it stays on that native session.
func (s *Store) pointAtNativeSession(ctx context.Context, session *store.AgentSession) (nativeSessionRow, bool, error) {
	row, found, err := s.currentNativeSession(ctx, session.ID, sessionRuntime(*session))
	if err != nil {
		return nativeSessionRow{}, false, err
	}
	if row.nativeID != session.NativeSessionID {
		session.ForkNativeSessionID = ""
	}
	session.NativeSessionID = row.nativeID
	return row, found, nil
}

// resumeNativeSession points the session at its current native session on
// the runtime it now runs on and returns what that native session has not
// seen of the conversation before input: the turns that ran elsewhere, or
// the whole conversation when the runtime has none yet. previousInputID is
// the input the session handled last; the native session that ran it has
// missed nothing.
func (s *Store) resumeNativeSession(ctx context.Context, session *store.AgentSession, previousInputID, inputID string) (string, error) {
	row, found, err := s.pointAtNativeSession(ctx, session)
	if err != nil {
		return "", err
	}
	if found && row.lastInputID != "" && row.lastInputID == previousInputID {
		return "", nil
	}
	events, err := s.sessionTranscriptEvents(ctx, session.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return conversationContext(events, "", inputID, true), nil
	}
	return conversationContext(events, row.lastInputID, inputID, false), nil
}

// bindNativeSession gives a new session the native history it starts from:
// a fork of another session, an adopted native chat, or a native session
// named by id. The session is not saved yet; its input is not recorded yet.
func (s *Store) bindNativeSession(ctx context.Context, session *store.AgentSession, input store.CreateAgentSessionInput, now time.Time) error {
	if forkID := strings.TrimSpace(input.ForkSessionID); forkID != "" {
		return s.forkNativeSession(ctx, session, forkID, "")
	}
	if chatID := strings.TrimSpace(input.ChatID); chatID != "" {
		chat, err := getJSON[store.ChatThread](ctx, s.conn(), `SELECT payload_json FROM chats WHERE id = ? AND workspace_id IN (?, '') AND `+visibleChatSQL, chatID, session.WorkspaceID)
		if err != nil {
			return err
		}
		return s.adoptNativeChat(ctx, session, chat, now)
	}
	nativeID := strings.TrimSpace(input.NativeSessionID)
	if nativeID == "" {
		return nil
	}
	owner, err := s.nativeSessionOwner(ctx, session.Provider, nativeID)
	if err != nil {
		return err
	}
	if owner != "" {
		// Another Foundry session's native session: continuing it is a fork,
		// so neither writes into the other's transcript.
		return s.forkNativeSession(ctx, session, owner, nativeID)
	}
	chat, err := getJSON[store.ChatThread](ctx, s.conn(), `SELECT payload_json FROM chats WHERE provider = ? AND native_session_id = ? AND workspace_id IN (?, '')`, session.Provider, nativeID, session.WorkspaceID)
	if err == nil {
		return s.adoptNativeChat(ctx, session, chat, now)
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return s.attachNativeSession(ctx, session, nativeID, "")
}

// forkNativeSession starts the session from a copy of another session's
// native history: nativeID, or the source's current native session on this
// runtime. Claude forks natively into an id assigned here, so the copy is
// claimed before it exists; Codex's SDK cannot fork, so its new thread
// starts from the source's Foundry conversation instead.
func (s *Store) forkNativeSession(ctx context.Context, session *store.AgentSession, sourceID, nativeID string) error {
	source, err := s.GetAgentSessionSummary(ctx, sourceID)
	if err != nil {
		return err
	}
	if nativeID == "" {
		row, found, err := s.currentNativeSession(ctx, source.ID, sessionRuntime(*session))
		if err != nil {
			return err
		}
		if found {
			nativeID = row.nativeID
		}
	}
	if nativeID != "" && session.Provider == "claude" {
		session.ForkNativeSessionID = nativeID
		return s.attachNativeSession(ctx, session, newNativeSessionUUID(), "")
	}
	events, err := s.sessionTranscriptEvents(ctx, source.ID)
	if err != nil {
		return err
	}
	session.Input.ImportedContext = conversationContext(events, "", "", true)
	return nil
}

// adoptNativeChat continues a device's native chat as this session: its
// transcript, title and list position become the session's, and its native
// session becomes the session's on that runtime. The chat leaves the list.
func (s *Store) adoptNativeChat(ctx context.Context, session *store.AgentSession, chat store.ChatThread, now time.Time) error {
	if chat.Provider == "" || chat.NativeSessionID == "" {
		return store.ErrNotFound
	}
	if owner, err := s.nativeSessionOwner(ctx, chat.Provider, chat.NativeSessionID); err != nil {
		return err
	} else if owner != "" {
		return store.ErrNotFound
	}
	for index, message := range chat.Transcript {
		message := message
		at := message.At
		if at == "" {
			at = formatTime(now)
		}
		if err := s.saveAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: "evt_native_" + session.ID + "_" + fmt.Sprint(index), SessionID: session.ID, At: at,
			Label: "Native transcript", Level: "info", Message: &message,
		}, now.Add(-time.Duration(len(chat.Transcript)-index)*time.Microsecond)); err != nil {
			return err
		}
	}
	if title := strings.TrimSpace(chat.Title); title != "" {
		session.Title = title
	}
	if err := s.moveChatIdentity(ctx, session.WorkspaceID, chat.ID, session.ID); err != nil {
		return err
	}
	// The conversation already has a name; a title record keeps automatic
	// naming from replacing it. A custom title moved above wins.
	if title := strings.TrimSpace(chat.Title); title != "" {
		if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO chat_titles (workspace_id, chat_id, title, version) VALUES (?, ?, ?, ?)`,
			session.WorkspaceID, session.ID, title, formatTime(now)); err != nil {
			return fmt.Errorf("keep adopted chat title: %w", err)
		}
	}
	runtime := nativeRuntime{provider: chat.Provider, deviceID: session.DeviceID}
	if chat.Provider == session.Provider {
		return s.attachNativeSession(ctx, session, chat.NativeSessionID, "")
	}
	if _, err := s.claimNativeSession(ctx, session.ID, runtime, chat.NativeSessionID, "", true); err != nil {
		return err
	}
	events, err := s.sessionTranscriptEvents(ctx, session.ID)
	if err != nil {
		return err
	}
	session.Input.ImportedContext = conversationContext(events, "", session.Input.ID, true)
	return nil
}

// moveChatIdentity hands a chat's custom title and list position to the
// session that continues it.
func (s *Store) moveChatIdentity(ctx context.Context, workspaceID, fromID, toID string) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE OR IGNORE chat_titles SET chat_id = ? WHERE workspace_id = ? AND chat_id = ?`, toID, workspaceID, fromID); err != nil {
		return fmt.Errorf("move chat title: %w", err)
	}
	var payload string
	var revision int64
	err := s.conn().QueryRowContext(ctx, `SELECT revision, payload_json FROM chat_layouts WHERE workspace_id = ?`, workspaceID).Scan(&revision, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var layout store.ChatLayout
	if err := json.Unmarshal([]byte(payload), &layout); err != nil {
		return err
	}
	moved := false
	for index := range layout.Positions {
		if layout.Positions[index].ChatID == fromID {
			layout.Positions[index].ChatID = toID
			moved = true
		}
	}
	if !moved {
		return nil
	}
	layout.Revision = revision + 1
	encoded, err := json.Marshal(layout)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE chat_layouts SET revision = ?, payload_json = ? WHERE workspace_id = ?`, layout.Revision, string(encoded), workspaceID)
	return err
}

// claimNativeChat reports whether a device's native chat belongs to a
// Foundry session, and is therefore not listed as a chat of its own. A
// Claude transcript holding a Foundry input (Foundry sends each input id
// as Claude's user message uuid) belongs to that input's session, which
// claims it as retired.
func (s *Store) claimNativeChat(ctx context.Context, chat store.ChatThread) (bool, error) {
	owner, err := s.nativeSessionOwner(ctx, chat.Provider, chat.NativeSessionID)
	if err != nil || owner != "" {
		return owner != "", err
	}
	if chat.Provider != "claude" {
		return false, nil
	}
	sessionID, deviceID, err := s.nativeTranscriptInputOwner(ctx, chat.Transcript)
	if err != nil || sessionID == "" {
		return false, err
	}
	claimed, err := s.claimNativeSession(ctx, sessionID, nativeRuntime{provider: chat.Provider, deviceID: deviceID}, chat.NativeSessionID, "", false)
	if err != nil || !claimed {
		return claimed, err
	}
	// Its turns' usage is now the session's: read the session's logs again.
	_, err = s.conn().ExecContext(ctx, `DELETE FROM agent_session_usage_backfills WHERE session_id = ?`, sessionID)
	return true, err
}

var transcriptInputID = regexp.MustCompile(`^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\d+$`)

func (s *Store) nativeTranscriptInputOwner(ctx context.Context, transcript []store.TranscriptMessage) (string, string, error) {
	for _, message := range transcript {
		if message.Kind != "user" {
			continue
		}
		match := transcriptInputID.FindStringSubmatch(message.ID)
		if match == nil {
			continue
		}
		var sessionID, deviceID string
		err := s.conn().QueryRowContext(ctx, `SELECT session.id, session.device_id FROM agent_session_events AS event
			JOIN agent_sessions AS session ON session.id = event.session_id
			WHERE event.id = ? AND json_extract(event.payload_json, '$.label') = ?`,
			"evt_"+match[1], store.SessionInputEventLabel).Scan(&sessionID, &deviceID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		return sessionID, deviceID, err
	}
	return "", "", nil
}

// AgentSessionNativeSessions lists every native session the session owns.
func (s *Store) AgentSessionNativeSessions(ctx context.Context, sessionID string) ([]store.NativeSessionRef, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT provider, native_id FROM agent_session_native_ids
		WHERE session_id = ? ORDER BY attached_at, native_id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := []store.NativeSessionRef{}
	for rows.Next() {
		var ref store.NativeSessionRef
		if err := rows.Scan(&ref.Provider, &ref.NativeSessionID); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

// AgentSessionConversation is the session's conversation before its current
// input, for a native session that has to start over without its history.
func (s *Store) AgentSessionConversation(ctx context.Context, sessionID string) (string, error) {
	session, err := s.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return "", err
	}
	events, err := s.sessionTranscriptEvents(ctx, session.ID)
	if err != nil {
		return "", err
	}
	return conversationContext(events, "", session.Input.ID, true), nil
}

func (s *Store) sessionTranscriptEvents(ctx context.Context, sessionID string) ([]store.AgentSessionEvent, error) {
	return listJSON[store.AgentSessionEvent](ctx, s.conn(), `SELECT payload_json FROM agent_session_events
		WHERE session_id = ? AND (json_type(payload_json, '$.message') IS NOT NULL OR json_extract(payload_json, '$.label') = 'Response stream')
		ORDER BY created_at ASC, id ASC`, sessionID)
}

// importedContextLimit matches what the web and the worker hand an agent as
// earlier conversation.
const importedContextLimit = 12000

type conversationTurn struct {
	inputID  string
	lines    []string
	answered bool
}

// conversationTurns splits a transcript into the history it started with
// (an adopted native chat) and one turn per input: what the person said and
// the answer.
func conversationTurns(events []store.AgentSessionEvent) []conversationTurn {
	turns := []conversationTurn{{}}
	answer := ""
	flush := func() {
		if answer != "" {
			turn := &turns[len(turns)-1]
			turn.lines = append(turn.lines, "Assistant: "+answer)
			turn.answered = true
		}
		answer = ""
	}
	for _, event := range events {
		message := event.Message
		switch {
		case message != nil && message.Kind == "user" && event.Label == store.SessionInputEventLabel:
			flush()
			turns = append(turns, conversationTurn{inputID: message.ID, lines: []string{"User: " + strings.TrimSpace(message.Text)}})
		case message != nil && message.Kind == "user":
			flush()
			turn := &turns[len(turns)-1]
			turn.lines = append(turn.lines, "User: "+strings.TrimSpace(message.Text))
		case message != nil && message.Kind == "assistant" && strings.TrimSpace(message.Text) != "":
			answer = strings.TrimSpace(message.Text)
		case message == nil && event.Label == "Response stream" && (event.Metadata == nil || event.Metadata.TaskID == "") && strings.TrimSpace(event.Detail) != "":
			answer = strings.TrimSpace(event.Detail)
		}
	}
	flush()
	turns[0].answered = true
	return turns
}

// conversationContext renders, as context for an agent, the answered turns
// after input `after` (every input when empty) and before input `before`,
// led by the starting history when withHistory is set. An `after` the
// transcript does not hold means nothing is known to be missing.
func conversationContext(events []store.AgentSessionEvent, after, before string, withHistory bool) string {
	turns := conversationTurns(events)
	start := 1
	if after != "" {
		start = -1
		for index, turn := range turns {
			if index > 0 && turn.inputID == after {
				start = index + 1
			}
		}
		if start < 0 {
			return ""
		}
	}
	var lines []string
	if withHistory {
		lines = append(lines, turns[0].lines...)
	}
	for _, turn := range turns[start:] {
		if before != "" && turn.inputID == before {
			break
		}
		if turn.answered {
			lines = append(lines, turn.lines...)
		}
	}
	return truncateContext(strings.TrimSpace(strings.Join(lines, "\n\n")))
}

func truncateContext(text string) string {
	const prefix = "Earlier context truncated.\n\n"
	runes := []rune(text)
	if len(runes) <= importedContextLimit {
		return text
	}
	return prefix + string(runes[len(runes)-(importedContextLimit-len(prefix)):])
}

// newNativeSessionUUID is a random (v4) UUID, the form Claude accepts as a
// session id.
func newNativeSessionUUID() string {
	var id [16]byte
	rand.Read(id[:]) // never fails since Go 1.24
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

// activityLayout is fixed-width, so stored activity times order as text.
const activityLayout = "2006-01-02T15:04:05.000000000Z07:00"

// activityTime normalizes an RFC 3339 time for activity ordering; "" when it
// is not one.
func activityTime(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(activityLayout)
}

// sessionActivity is the last conversation activity of a session: its latest
// input, or the answer that completed it.
func sessionActivity(session store.AgentSession, fallback time.Time) string {
	latest := activityTime(session.ActivityAt)
	candidates := []string{session.Input.At}
	if session.Status == "completed" {
		candidates = append(candidates, session.CompletedAt)
	}
	for _, candidate := range candidates {
		if value := activityTime(candidate); value > latest {
			latest = value
		}
	}
	if latest == "" {
		latest = fallback.UTC().Format(activityLayout)
	}
	return latest
}

// migrateNativeSessions keeps the ownership table and the activity columns
// true to what is stored. It runs on every start, with no one-time marker:
// whatever an older server wrote meanwhile (a native id it switched to,
// payloads without activity, native chats it synced back) is repaired, and
// on consistent data it writes nothing.
func (s *Store) migrateNativeSessions(ctx context.Context) error {
	return s.withTx(ctx, func(tx *Store) error {
		for _, statement := range nativeSessionSchema() {
			if _, err := tx.conn().ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("migrate native sessions: %w", err)
			}
		}
		if err := tx.migrateActivityColumns(ctx); err != nil {
			return err
		}
		if err := tx.backfillNativeSessions(ctx); err != nil {
			return err
		}
		if _, err := tx.linkNativeTranscripts(ctx); err != nil {
			return err
		}
		return tx.removeNativeChatsWithoutTurns(ctx)
	})
}

// nativeChatWithoutTurns is a device's native session file that holds no
// conversation, such as the stub a terminal `/resume` leaves behind. Only an
// upload that carries the transcript can tell; a summary has none.
func nativeChatWithoutTurns(chat store.ChatThread) bool {
	return chat.NativeSessionID != "" && chat.Transcript != nil && !chatHasTurns(chat)
}

func chatHasTurns(chat store.ChatThread) bool {
	if len(chat.RecentMessages) > 0 {
		return true
	}
	for _, message := range chat.Transcript {
		if message.Kind == "user" || message.Kind == "assistant" {
			return true
		}
	}
	return false
}

// removeNativeChatsWithoutTurns drops stored native chats that hold no
// conversation; workers before this rule listed them. A stored payload omits
// an empty transcript, so here no recap and no turn is enough.
func (s *Store) removeNativeChatsWithoutTurns(ctx context.Context) error {
	var empty []store.ChatThread
	err := scanRows(ctx, s.conn(), `SELECT payload_json FROM chats WHERE native_session_id <> ''
		AND COALESCE(json_array_length(payload_json, '$.recentMessages'), 0) = 0`, func(rows *sql.Rows) error {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return err
		}
		var chat store.ChatThread
		if err := json.Unmarshal([]byte(payload), &chat); err != nil {
			return err
		}
		if !chatHasTurns(chat) {
			empty = append(empty, chat)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("find native chats without turns: %w", err)
	}
	for _, chat := range empty {
		if err := s.deleteNativeChat(ctx, chat.Provider, chat.NativeSessionID); err != nil {
			return err
		}
	}
	return nil
}

// migrateActivityColumns gives chats and sessions the indexed columns their
// lists filter and order by, and brings any that disagree with their
// payload back in line.
func (s *Store) migrateActivityColumns(ctx context.Context) error {
	for _, column := range []struct{ table, name, statement string }{
		{"chats", "workspace_id", `ALTER TABLE chats ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`},
		{"chats", "provider", `ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT ''`},
		{"chats", "native_session_id", `ALTER TABLE chats ADD COLUMN native_session_id TEXT NOT NULL DEFAULT ''`},
		{"chats", "activity_at", `ALTER TABLE chats ADD COLUMN activity_at TEXT NOT NULL DEFAULT ''`},
		{"agent_sessions", "activity_at", `ALTER TABLE agent_sessions ADD COLUMN activity_at TEXT NOT NULL DEFAULT ''`},
	} {
		if err := s.ensureColumn(ctx, column.table, column.name, column.statement); err != nil {
			return err
		}
	}
	for _, statement := range []string{
		`CREATE INDEX IF NOT EXISTS idx_chats_workspace_activity ON chats (workspace_id, activity_at DESC, id)`,
		`CREATE INDEX IF NOT EXISTS idx_chats_native ON chats (provider, native_session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_activity ON agent_sessions (workspace_id, activity_at DESC)`,
		`UPDATE chats SET
			workspace_id = COALESCE(json_extract(payload_json, '$.workspaceId'), ''),
			provider = COALESCE(json_extract(payload_json, '$.provider'), ''),
			native_session_id = COALESCE(json_extract(payload_json, '$.nativeSessionId'), '')
		WHERE workspace_id <> COALESCE(json_extract(payload_json, '$.workspaceId'), '')
			OR provider <> COALESCE(json_extract(payload_json, '$.provider'), '')
			OR native_session_id <> COALESCE(json_extract(payload_json, '$.nativeSessionId'), '')`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate activity columns: %w", err)
		}
	}
	type chatTime struct{ id, updatedAt, activity string }
	var chats []chatTime
	if err := scanRows(ctx, s.conn(), `SELECT id, COALESCE(json_extract(payload_json, '$.updatedAt'), ''), activity_at FROM chats`, func(rows *sql.Rows) error {
		var row chatTime
		if err := rows.Scan(&row.id, &row.updatedAt, &row.activity); err != nil {
			return err
		}
		chats = append(chats, row)
		return nil
	}); err != nil {
		return err
	}
	for _, chat := range chats {
		if activity := activityTime(chat.updatedAt); activity != chat.activity {
			if _, err := s.conn().ExecContext(ctx, `UPDATE chats SET activity_at = ? WHERE id = ?`, activity, chat.id); err != nil {
				return fmt.Errorf("backfill chat activity: %w", err)
			}
		}
	}
	// A server without the column rewrote these payloads without activity.
	type sessionTime struct{ id, payload, createdAt, activity string }
	var sessions []sessionTime
	if err := scanRows(ctx, s.conn(), `SELECT id, json_remove(payload_json, '$.events', '$.response', '$.input.importedContext'), created_at, activity_at
		FROM agent_sessions
		WHERE activity_at = '' OR json_extract(payload_json, '$.activityAt') IS NOT activity_at`, func(rows *sql.Rows) error {
		var row sessionTime
		if err := rows.Scan(&row.id, &row.payload, &row.createdAt, &row.activity); err != nil {
			return err
		}
		sessions = append(sessions, row)
		return nil
	}); err != nil {
		return err
	}
	for _, row := range sessions {
		var session store.AgentSession
		if err := json.Unmarshal([]byte(row.payload), &session); err != nil {
			return err
		}
		if activityTime(row.activity) > activityTime(session.ActivityAt) {
			session.ActivityAt = row.activity
		}
		created, _ := time.Parse(time.RFC3339Nano, row.createdAt)
		activity := sessionActivity(session, created)
		if _, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions SET activity_at = ?, payload_json = json_set(payload_json, '$.activityAt', ?) WHERE id = ?`, activity, activity, row.id); err != nil {
			return fmt.Errorf("backfill session activity: %w", err)
		}
	}
	return nil
}

func scanRows(ctx context.Context, db dbExecutor, query string, scan func(*sql.Rows) error, args ...any) error {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func chatActivity(chat store.ChatThread) string {
	return activityTime(chat.UpdatedAt)
}

// backfillNativeSessions claims the native sessions session payloads name
// that the table does not hold yet: the current one (a server that predates
// the table switched to it) and the ones an agent or account switch left
// in priorNativeSessions. Oldest owners first; an existing claim is kept.
func (s *Store) backfillNativeSessions(ctx context.Context) error {
	type payloadClaim struct {
		sessionID, provider, deviceID, nativeID, inputID string
		prior                                            []store.NativeSessionRef
	}
	var claims []payloadClaim
	if err := scanRows(ctx, s.conn(), `SELECT s.id, s.provider, s.device_id,
			COALESCE(json_extract(s.payload_json, '$.nativeSessionId'), ''),
			COALESCE(json_extract(s.payload_json, '$.input.id'), ''),
			COALESCE(json_extract(s.payload_json, '$.priorNativeSessions'), '[]')
		FROM agent_sessions AS s
		WHERE (COALESCE(json_extract(s.payload_json, '$.nativeSessionId'), '') <> '' AND NOT EXISTS (
				SELECT 1 FROM agent_session_native_ids AS n
				WHERE n.session_id = s.id AND n.provider = s.provider AND n.device_id = s.device_id
					AND n.current = 1 AND n.native_id = json_extract(s.payload_json, '$.nativeSessionId')))
			OR json_type(s.payload_json, '$.priorNativeSessions') = 'array'
		ORDER BY s.created_at ASC, s.id ASC`, func(rows *sql.Rows) error {
		var claim payloadClaim
		var priorJSON string
		if err := rows.Scan(&claim.sessionID, &claim.provider, &claim.deviceID, &claim.nativeID, &claim.inputID, &priorJSON); err != nil {
			return err
		}
		_ = json.Unmarshal([]byte(priorJSON), &claim.prior)
		claims = append(claims, claim)
		return nil
	}); err != nil {
		return err
	}
	for _, claim := range claims {
		for _, prior := range claim.prior {
			owner, err := s.nativeSessionOwner(ctx, prior.Provider, prior.NativeSessionID)
			if err != nil {
				return err
			}
			if owner != "" {
				continue
			}
			if _, err := s.claimNativeSession(ctx, claim.sessionID, nativeRuntime{provider: prior.Provider, deviceID: claim.deviceID}, prior.NativeSessionID, "", false); err != nil {
				return err
			}
		}
		runtime := nativeRuntime{provider: claim.provider, deviceID: claim.deviceID}
		current, found, err := s.currentNativeSession(ctx, claim.sessionID, runtime)
		if err != nil {
			return err
		}
		if claim.nativeID == "" || (found && current.nativeID == claim.nativeID) {
			continue
		}
		if _, err := s.claimNativeSession(ctx, claim.sessionID, runtime, claim.nativeID, claim.inputID, true); err != nil {
			return err
		}
	}
	return nil
}

// linkNativeTranscripts claims each stored native chat that belongs to a
// Foundry session and removes every claimed one from the chats. It returns
// the native sessions it linked by transcript.
func (s *Store) linkNativeTranscripts(ctx context.Context) ([]store.NativeSessionRef, error) {
	ids, err := listStrings(ctx, s.conn(), `SELECT id FROM chats WHERE provider = 'claude' AND NOT `+nativeClaimedSQL+`
		AND json_type(payload_json, '$.transcript') = 'array'`)
	if err != nil {
		return nil, err
	}
	linked := []store.NativeSessionRef{}
	for _, id := range ids {
		chat, err := getJSON[store.ChatThread](ctx, s.conn(), `SELECT payload_json FROM chats WHERE id = ?`, id)
		if err != nil {
			return nil, err
		}
		claimed, err := s.claimNativeChat(ctx, chat)
		if err != nil {
			return nil, err
		}
		if claimed {
			linked = append(linked, store.NativeSessionRef{Provider: chat.Provider, NativeSessionID: chat.NativeSessionID})
		}
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM chats WHERE `+nativeClaimedSQL); err != nil {
		return nil, fmt.Errorf("remove claimed native chats: %w", err)
	}
	return linked, nil
}

func listStrings(ctx context.Context, db dbExecutor, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

// nativeDeletionKeys are the chat-deletion keys of every native session the
// sessions own, so a deleted conversation's native records stay deleted.
func (s *Store) nativeDeletionKeys(ctx context.Context, sessionIDs []string) ([]string, error) {
	keys := []string{}
	for _, sessionID := range sessionIDs {
		refs, err := s.AgentSessionNativeSessions(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		for _, ref := range refs {
			keys = append(keys, "native:"+ref.Provider+":"+ref.NativeSessionID)
		}
	}
	return keys, nil
}
