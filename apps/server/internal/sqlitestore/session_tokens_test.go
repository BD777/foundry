package sqlitestore

import (
	"context"
	"testing"
	"time"
)

func TestSessionTokenLifetime(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	future := formatTime(now.Add(time.Hour))
	recent := formatTime(now.Add(-23 * time.Hour))
	stale := formatTime(now.Add(-25 * time.Hour))
	cases := []struct {
		name              string
		expires, lastUsed string
		status            string
		want              bool
	}{
		{"settled, used within a day", future, recent, "completed", true},
		{"settled, unused for a day", future, stale, "completed", false},
		{"running, unused for a day", future, stale, "running", true},
		{"blocked, unused for a day", future, stale, "blocked", true},
		{"past its hard expiry while running", formatTime(now.Add(-time.Second)), recent, "running", false},
		{"unreadable expiry", "", recent, "running", false},
		{"unreadable last use", future, "", "failed", false},
	}
	for _, c := range cases {
		if got := sessionTokenLive(now, c.expires, c.lastUsed, c.status); got != c.want {
			t.Errorf("%s: live = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSessionTokenExpiresAfterIdleSettledSession(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	execAll(t, db,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('sess_tok', 'ws_tok', 'agent_tok', 'dev_tok', 'claude', 'running', '{}', '', '')`)
	token, err := db.MintAgentSessionToken(ctx, "sess_tok")
	if err != nil {
		t.Fatal(err)
	}
	stale := formatTime(time.Now().UTC().Add(-agentSessionTokenIdle - time.Minute))
	execAll(t, db, `UPDATE session_tokens SET last_used_at = '`+stale+`'`)
	if _, err := db.ResolveSessionToken(ctx, token); err != nil {
		t.Fatalf("a running session's idle token: %v; want it valid", err)
	}
	execAll(t, db,
		`UPDATE session_tokens SET last_used_at = '`+stale+`'`,
		`UPDATE agent_sessions SET status = 'completed'`)
	if _, err := db.ResolveSessionToken(ctx, token); err != ErrSessionTokenInvalid {
		t.Fatalf("a settled session's idle token: %v; want ErrSessionTokenInvalid", err)
	}
	var left int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM session_tokens`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("expired tokens left = %d, %v; want the row deleted", left, err)
	}
}
