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

// A reused Claude process keeps the token of an earlier turn (DEV-084): the
// worker relies on it working for up to 20 h after it was minted, whatever
// the session did in between, before and after the next dispatch.
func TestEarlierSessionTokenServesReusedProcess(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	execAll(t, db,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('sess_reuse', 'ws_reuse', 'agent_reuse', 'dev_reuse', 'claude', 'running', '{}', '', '')`)
	held, err := db.MintAgentSessionToken(ctx, "sess_reuse")
	if err != nil {
		t.Fatal(err)
	}
	// The turn ends, the session idles; nothing used the token since it was
	// minted 20 h ago, and a timer's call resolves it while idle.
	minted := formatTime(time.Now().UTC().Add(-20 * time.Hour))
	execAll(t, db,
		`UPDATE session_tokens SET created_at = '`+minted+`', last_used_at = '`+minted+`'`,
		`UPDATE agent_sessions SET status = 'completed'`)
	if _, err := db.ResolveSessionToken(ctx, held); err != nil {
		t.Fatalf("idle session, token minted 20 h ago: %v; want valid", err)
	}
	// The next dispatch mints another token; the held one still works.
	if _, err := db.MintAgentSessionToken(ctx, "sess_reuse"); err != nil {
		t.Fatal(err)
	}
	execAll(t, db, `UPDATE agent_sessions SET status = 'running'`)
	identity, err := db.ResolveSessionToken(ctx, held)
	if err != nil || identity.SessionID != "sess_reuse" {
		t.Fatalf("held token on the next turn: %+v, %v; want sess_reuse", identity, err)
	}
}

// A lease's command token resolves to its session with the lease named; the
// session's own tokens name none. The column joins a table made without it.
func TestLeaseCommandTokenNamesItsLease(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	execAll(t, db,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('sess_tok', 'ws_tok', 'agent_tok', 'dev_tok', 'claude', 'running', '{}', '', '')`)
	own, err := db.MintAgentSessionToken(ctx, "sess_tok")
	if err != nil {
		t.Fatal(err)
	}
	command, err := db.MintLeaseCommandToken(ctx, "sess_tok", "lease_1")
	if err != nil {
		t.Fatal(err)
	}
	if identity, err := db.ResolveSessionToken(ctx, own); err != nil || identity.SessionID != "sess_tok" || identity.LeaseID != "" {
		t.Fatalf("own token = %+v, %v", identity, err)
	}
	if identity, err := db.ResolveSessionToken(ctx, command); err != nil || identity.SessionID != "sess_tok" || identity.LeaseID != "lease_1" ||
		identity.WorkspaceID != "ws_tok" {
		t.Fatalf("command token = %+v, %v", identity, err)
	}
	if _, err := db.MintLeaseCommandToken(ctx, "sess_tok", " "); err == nil {
		t.Fatal("a command token without a lease was minted")
	}

	execAll(t, db, `ALTER TABLE session_tokens DROP COLUMN lease_id`)
	for range 2 {
		if err := db.setupSessionTokenLeases(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if identity, err := db.ResolveSessionToken(ctx, command); err != nil || identity.LeaseID != "" {
		t.Fatalf("a token from before the column = %+v, %v", identity, err)
	}
}
