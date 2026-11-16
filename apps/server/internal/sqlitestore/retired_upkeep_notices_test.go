package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	retiredTestHomeWorkspace  = "ws_home"
	retiredTestPlainWorkspace = "ws_plain"
	retiredTestOwner          = "user_a"
)

func insertRetiredTestAssistant(t *testing.T, s *Store, id, owner, workspace string) {
	t.Helper()
	if _, err := s.conn().ExecContext(context.Background(),
		`INSERT INTO assistants(id, owner_user_id, home_workspace_id, home_device_id, state, settings_json, created_at, updated_at)
		VALUES(?,?,?,?,?,?,?,?)`,
		id, owner, workspace, "dev_test", store.PersonalAgentActive, "{}", "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"); err != nil {
		t.Fatalf("insert assistant %s: %v", id, err)
	}
}

func insertRetiredTestSession(t *testing.T, s *Store, id, workspace, parent string, payload map[string]any) {
	t.Helper()
	payload["id"] = id
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal session %s: %v", id, err)
	}
	if _, err := s.conn().ExecContext(context.Background(),
		`INSERT INTO agent_sessions(id, workspace_id, agent_id, device_id, provider, status, parent_session_id, payload_json, created_at, updated_at)
		VALUES(?,?,'','dev_test','claude','idle',?,?,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
		id, workspace, parent, string(raw)); err != nil {
		t.Fatalf("insert session %s: %v", id, err)
	}
}

func insertRetiredTestEvent(t *testing.T, s *Store, sessionID, id, at, text string, source map[string]any) {
	t.Helper()
	payload := map[string]any{
		"id": id, "sessionId": sessionID, "at": at, "label": store.EventLabelUserMessage, "level": "info",
		"message": map[string]any{"id": id, "kind": "user", "text": text},
	}
	if source != nil {
		payload["metadata"] = map[string]any{"inputSource": source}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal event %s: %v", id, err)
	}
	if _, err := s.conn().ExecContext(context.Background(),
		`INSERT INTO agent_session_events(id, session_id, level, payload_json, created_at) VALUES(?,?,?,?,?)`,
		id, sessionID, "info", string(raw), at); err != nil {
		t.Fatalf("insert event %s: %v", id, err)
	}
}

// seedRetiredUpkeepFixture: an assistant's home conversation (sess_home) and
// sessions that look like it but are not, each with one upkeep-looking input.
func seedRetiredUpkeepFixture(t *testing.T, s *Store) {
	t.Helper()
	insertRetiredTestAssistant(t, s, "asst_a", retiredTestOwner, retiredTestHomeWorkspace)
	insertRetiredTestSession(t, s, "sess_home", retiredTestHomeWorkspace, "",
		map[string]any{"createdByUserId": retiredTestOwner, "source": "chat"})
	insertRetiredTestSession(t, s, "sess_child", retiredTestHomeWorkspace, "sess_home",
		map[string]any{"createdByUserId": retiredTestOwner, "source": "chat"})
	insertRetiredTestSession(t, s, "sess_other_user", retiredTestHomeWorkspace, "",
		map[string]any{"createdByUserId": "user_b", "source": "chat"})
	insertRetiredTestSession(t, s, "sess_agent", retiredTestHomeWorkspace, "",
		map[string]any{"createdByUserId": retiredTestOwner, "source": "agent"})
	insertRetiredTestSession(t, s, "sess_issue", retiredTestHomeWorkspace, "",
		map[string]any{"createdByUserId": retiredTestOwner, "source": "chat", "role": "issue_execution"})
	insertRetiredTestSession(t, s, "sess_plain", retiredTestPlainWorkspace, "",
		map[string]any{"createdByUserId": retiredTestOwner, "source": "chat"})
}

const (
	retiredTestUpkeepZh    = "[Foundry] 项目维护：6 个项目共 8 条修改建议等本人确认（设置 → 维护，或打开 https://example.test/settings）。"
	retiredTestSummariesZh = "[Foundry] 项目摘要：25 个项目的摘要等着「mac」上线。"
	retiredTestUpkeepEn    = "[Foundry] Project upkeep: 6 projects have 8 suggested changes waiting for the person's approval."
	retiredTestSummariesEn = "[Foundry] Project summaries: 3 are waiting for \"mac\" to come online."
)

type retiredTestEvent struct {
	session, id, at, text string
	source                map[string]any
	want                  sql.NullString
}

func retiredTestSource(kind string, extra map[string]any) map[string]any {
	source := map[string]any{"kind": kind}
	for key, value := range extra {
		source[key] = value
	}
	return source
}

func retiredTestEvents() []retiredTestEvent {
	upkeep := sql.NullString{String: store.NoticeKindUpkeep, Valid: true}
	none := sql.NullString{}
	notice := retiredTestSource("foundry_notice", nil)
	return []retiredTestEvent{
		{"sess_home", "evt_notice_upkeep", "2026-11-16T04:02:47.731046712Z", retiredTestUpkeepZh, notice, upkeep},
		{"sess_home", "evt_legacy_upkeep", "2026-11-16T03:04:38Z", retiredTestUpkeepZh, nil, upkeep},
		{"sess_home", "evt_legacy_summaries_zh", "2026-11-15T20:07:43.965596629Z", retiredTestSummariesZh, nil, upkeep},
		{"sess_home", "evt_legacy_upkeep_en", "2026-11-16T05:00:00Z", retiredTestUpkeepEn, nil, upkeep},
		{"sess_home", "evt_legacy_summaries_en", "2026-11-16T07:00:00Z", retiredTestSummariesEn, nil, upkeep},
		{"sess_home", "evt_just_before_cutoff", "2026-11-16T08:09:59.999999999Z", retiredTestUpkeepZh, nil, upkeep},
		{"sess_home", "evt_at_cutoff", "2026-11-16T08:10:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_home", "evt_fraction_in_cutoff_second", "2026-11-16T08:10:00.5Z", retiredTestUpkeepZh, nil, none},
		{"sess_home", "evt_after_cutoff", "2026-11-16T09:00:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_home", "evt_prefix_not_at_start", "2026-11-16T06:00:00Z", "[Foundry] 提醒：项目维护：3 项", nil, none},
		{"sess_home", "evt_reminder", "2026-11-16T06:00:00Z", retiredTestUpkeepZh,
			retiredTestSource("foundry_notice", map[string]any{"noticeKind": store.NoticeKindReminder}),
			sql.NullString{String: store.NoticeKindReminder, Valid: true}},
		{"sess_home", "evt_digest_marked", "2026-11-16T06:00:00Z", retiredTestSummariesZh,
			retiredTestSource("foundry_notice", map[string]any{"noticeKind": store.NoticeKindDigest}),
			sql.NullString{String: store.NoticeKindDigest, Valid: true}},
		{"sess_home", "evt_person_same_text", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, retiredTestSource("person", nil), none},
		{"sess_home", "evt_session_same_text", "2026-11-16T06:00:00Z", retiredTestUpkeepZh,
			retiredTestSource("session", map[string]any{"sessionId": "sess_other"}), none},
		{"sess_child", "evt_child_legacy", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_other_user", "evt_other_user_legacy", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_agent", "evt_agent_legacy", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_issue", "evt_issue_legacy", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, nil, none},
		{"sess_plain", "evt_plain_notice", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, notice, none},
		{"sess_plain", "evt_plain_legacy", "2026-11-16T06:00:00Z", retiredTestUpkeepZh, nil, none},
	}
}

func assertRetiredTestEvents(t *testing.T, s *Store, events []retiredTestEvent) {
	t.Helper()
	for _, event := range events {
		if got := noticeKindOfEvent(t, s, event.id); got != event.want {
			t.Errorf("%s: noticeKind = %+v, want %+v", event.id, got, event.want)
		}
		if !event.want.Valid || event.want.String != store.NoticeKindUpkeep {
			continue
		}
		var stored store.AgentSessionEvent
		var payload string
		if err := s.conn().QueryRowContext(context.Background(),
			`SELECT payload_json FROM agent_session_events WHERE id = ?`, event.id).Scan(&payload); err != nil {
			t.Fatalf("read payload %s: %v", event.id, err)
		}
		if err := json.Unmarshal([]byte(payload), &stored); err != nil {
			t.Fatalf("decode %s: %v", event.id, err)
		}
		if stored.Metadata == nil || stored.Metadata.InputSource == nil ||
			stored.Metadata.InputSource.Kind != "foundry_notice" || stored.Metadata.InputSource.NoticeKind != store.NoticeKindUpkeep {
			t.Errorf("%s: decoded input source = %+v, want foundry_notice/upkeep", event.id, stored.Metadata)
		}
		if stored.Message == nil || stored.Message.Text != event.text {
			t.Errorf("%s: message text changed by the migration", event.id)
		}
	}
}

func noticeKindOfEvent(t *testing.T, s *Store, id string) sql.NullString {
	t.Helper()
	var kind sql.NullString
	if err := s.conn().QueryRowContext(context.Background(),
		`SELECT json_extract(payload_json, '$.metadata.inputSource.noticeKind') FROM agent_session_events WHERE id = ?`,
		id).Scan(&kind); err != nil {
		t.Fatalf("read noticeKind of %s: %v", id, err)
	}
	return kind
}

func TestRetiredUpkeepNoticesMigrationRunsOnceAndMatchesOnlyAssistantHomeUpkeepInputs(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "foundry.db")

	// A database from before the migration: the open ran it over an empty
	// table, so drop its record and seed the old rows.
	first := openTestStore(t, path)
	seedRetiredUpkeepFixture(t, first)
	events := retiredTestEvents()
	for _, event := range events {
		insertRetiredTestEvent(t, first, event.session, event.id, event.at, event.text, event.source)
	}
	if _, err := first.conn().ExecContext(ctx, `DELETE FROM data_migrations WHERE name = ?`, retiredUpkeepNoticeMigration); err != nil {
		t.Fatalf("clear record: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// The next start runs the migration once.
	second := openTestStore(t, path)
	assertRetiredTestEvents(t, second, events)
	late := retiredTestEvent{session: "sess_home", id: "evt_late", at: "2026-11-16T06:30:00Z", text: retiredTestUpkeepZh}
	insertRetiredTestEvent(t, second, late.session, late.id, late.at, late.text, nil)
	if err := second.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// A later start finds the record and skips the migration: the late row
	// stays as it was.
	third := openTestStore(t, path)
	defer third.Close()
	if got := noticeKindOfEvent(t, third, late.id); got.Valid {
		t.Errorf("%s: skipped run still marked the row: %+v", late.id, got)
	}
	var version int
	if err := third.conn().QueryRowContext(ctx, `SELECT version FROM data_migrations WHERE name = ?`,
		retiredUpkeepNoticeMigration).Scan(&version); err != nil || version != retiredUpkeepNoticeVersion {
		t.Errorf("recorded version = %d (%v), want %d", version, err, retiredUpkeepNoticeVersion)
	}
}
