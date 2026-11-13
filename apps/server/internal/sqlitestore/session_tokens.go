package sqlitestore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Session-scoped bearer tokens for the agent-facing MCP/CLI surface.
// Plaintext is minted at dispatch, sent to the daemon inside the ephemeral
// run_session payload, and never persisted or logged; the store only keeps a
// SHA-256 hash. Deleting the session revokes every token it was given.
//
// A token is valid for as long as its session exists and is not archived,
// whatever its turns do (DEV-215): the agent process it was given to (a
// Claude process kept between turns, its background work, timers and
// subagents, a kept Codex app-server) acts for the session until then.
// Archiving or deleting the session revokes it; no token outlives
// agentSessionTokenTTL (a reused process is handed a newer one well before:
// foundry-tools.ts heldTokenTrustMs).

const (
	agentSessionTokenTTL = 30 * 24 * time.Hour
	// A lease's command token is bounded by its lease (checked per call);
	// this only caps a token whose lease record is gone.
	leaseCommandTokenTTL = 24 * time.Hour
)

var ErrSessionTokenInvalid = errors.New("invalid or expired session token")

// MintAgentSessionToken creates a fresh token, persists only its hash, and
// returns the plaintext exactly once. Earlier tokens of the session stay
// valid, since a reused agent process still holds them.
func (s *Store) MintAgentSessionToken(ctx context.Context, sessionID string) (string, error) {
	return s.mintSessionToken(ctx, sessionID, "", agentSessionTokenTTL)
}

// MintLeaseCommandToken creates a token for the commands a session hands one
// of its resource leases to (acquire_resource forCommands): it resolves to the
// session with LeaseID set, which the server lets call only that lease's
// resource tools while the session holds it (httpapi commandLease).
func (s *Store) MintLeaseCommandToken(ctx context.Context, sessionID, leaseID string) (string, error) {
	if strings.TrimSpace(leaseID) == "" {
		return "", errors.New("mint lease command token: no lease")
	}
	return s.mintSessionToken(ctx, sessionID, leaseID, leaseCommandTokenTTL)
}

func (s *Store) mintSessionToken(ctx context.Context, sessionID, leaseID string, ttl time.Duration) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("mint session token: %w", err)
	}
	plaintext := hex.EncodeToString(raw)
	hash := hashSessionToken(plaintext)
	now := time.Now().UTC()
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO session_tokens
		(token_hash, session_id, lease_id, created_at, last_used_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		hash, sessionID, leaseID, formatTime(now), formatTime(now), formatTime(now.Add(ttl))); err != nil {
		return "", fmt.Errorf("persist session token: %w", err)
	}
	return plaintext, nil
}

// setupSessionTokenLeases adds session_tokens.lease_id (DEV-145), which
// joined the table after it was first made.
func (s *Store) setupSessionTokenLeases(ctx context.Context) error {
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('session_tokens') WHERE name = 'lease_id'`).Scan(&present); err != nil {
		return fmt.Errorf("migrate sqlite session tokens: %w", err)
	}
	if present > 0 {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `ALTER TABLE session_tokens ADD COLUMN lease_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("migrate sqlite session tokens: %w", err)
	}
	return nil
}

func hashSessionToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// ResolveSessionToken validates a bearer token and returns the acting
// session's identity. Expired rows are deleted; a deleted session's tokens
// never resolve.
func (s *Store) ResolveSessionToken(ctx context.Context, plaintext string) (store.SessionTokenIdentity, error) {
	plaintext = trimToken(plaintext)
	if plaintext == "" {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	hash := hashSessionToken(plaintext)
	var identity store.SessionTokenIdentity
	var workspaceID, deviceID sql.NullString
	var expiresAt string
	var archived bool
	err := s.conn().QueryRowContext(ctx, `SELECT token.session_id, token.lease_id,
			COALESCE(NULLIF(session.workspace_id, ''), ''),
			COALESCE(NULLIF(session.device_id, ''), ''),
			token.expires_at, `+strings.ReplaceAll(archivedSessionSQL, "agent_sessions.", "session.")+`
		FROM session_tokens AS token
		JOIN agent_sessions AS session ON session.id = token.session_id
		WHERE token.token_hash = ? AND NOT EXISTS (SELECT 1 FROM chat_deletions d
			WHERE d.workspace_id = session.workspace_id AND d.deletion_key IN (
				'id:' || session.id,
				'native:' || session.provider || ':' || json_extract(session.payload_json, '$.nativeSessionId')))`,
		hash).Scan(&identity.SessionID, &identity.LeaseID, &workspaceID, &deviceID, &expiresAt, &archived)
	if errors.Is(err, sql.ErrNoRows) {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	if err != nil {
		return store.SessionTokenIdentity{}, err
	}
	if archived {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	if expiry, err := time.Parse(time.RFC3339Nano, expiresAt); err != nil || time.Now().After(expiry) {
		_, _ = s.conn().ExecContext(ctx, `DELETE FROM session_tokens WHERE token_hash = ?`, hash)
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	identity.WorkspaceID = workspaceID.String
	identity.DeviceID = deviceID.String
	_, _ = s.conn().ExecContext(ctx, `UPDATE session_tokens SET last_used_at = ? WHERE token_hash = ?`,
		formatTime(time.Now().UTC()), hash)
	return identity, nil
}

func trimToken(value string) string {
	return strings.TrimSpace(value)
}
