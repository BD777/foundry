package sqlitestore

import (
	"context"
	"testing"
	"time"
)

// DEV-215: a session's token works for as long as the session exists and
// is not archived, whatever its turns do: a kept agent process, its
// background work and timers use it days after the last turn, and after a
// failed or canceled one. Archiving revokes it; so does its hard expiry.
func TestSessionTokenFollowsTheSessionNotItsTurns(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	execAll(t, db,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('sess_tok', 'ws_tok', 'agent_tok', 'dev_tok', 'claude', 'running', '{}', '', '')`)
	token, err := db.MintAgentSessionToken(ctx, "sess_tok")
	if err != nil {
		t.Fatal(err)
	}
	unused := formatTime(time.Now().UTC().Add(-7 * 24 * time.Hour))
	for _, status := range []string{"running", "completed", "failed", "canceled"} {
		execAll(t, db,
			`UPDATE session_tokens SET last_used_at = '`+unused+`'`,
			`UPDATE agent_sessions SET status = '`+status+`'`)
		if identity, err := db.ResolveSessionToken(ctx, token); err != nil || identity.SessionID != "sess_tok" {
			t.Fatalf("%s session, token unused for a week: %+v, %v; want valid", status, identity, err)
		}
	}
	execAll(t, db, `INSERT INTO chat_archives (workspace_id, archive_key, archived_at, batch_id) VALUES ('ws_tok', 'id:sess_tok', '`+formatTime(time.Now())+`', 'b1')`)
	if _, err := db.ResolveSessionToken(ctx, token); err != ErrSessionTokenInvalid {
		t.Fatalf("archived session's token: %v; want ErrSessionTokenInvalid", err)
	}
	execAll(t, db, `DELETE FROM chat_archives`)
	if _, err := db.ResolveSessionToken(ctx, token); err != nil {
		t.Fatalf("restored session's token: %v; want valid", err)
	}
	execAll(t, db, `UPDATE session_tokens SET expires_at = '`+formatTime(time.Now().Add(-time.Second))+`'`)
	if _, err := db.ResolveSessionToken(ctx, token); err != ErrSessionTokenInvalid {
		t.Fatalf("expired token: %v; want ErrSessionTokenInvalid", err)
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
