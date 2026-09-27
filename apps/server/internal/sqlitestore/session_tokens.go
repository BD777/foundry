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
// SHA-256 hash. A token lives as long as its session (or its TTL): deleting
// the session revokes every token it was given.

const agentSessionTokenTTL = 30 * 24 * time.Hour

var ErrSessionTokenInvalid = errors.New("invalid or expired session token")

// MintAgentSessionToken creates a fresh token, persists only its hash, and
// returns the plaintext exactly once. Earlier tokens of the session stay
// valid, since a reused agent process still holds them.
func (s *Store) MintAgentSessionToken(ctx context.Context, sessionID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("mint session token: %w", err)
	}
	plaintext := hex.EncodeToString(raw)
	hash := hashSessionToken(plaintext)
	now := time.Now().UTC()
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO session_tokens
		(token_hash, session_id, created_at, last_used_at, expires_at)
		VALUES (?, ?, ?, ?, ?)`,
		hash, sessionID, formatTime(now), formatTime(now), formatTime(now.Add(agentSessionTokenTTL))); err != nil {
		return "", fmt.Errorf("persist session token: %w", err)
	}
	return plaintext, nil
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
	err := s.conn().QueryRowContext(ctx, `SELECT token.session_id,
			COALESCE(NULLIF(session.workspace_id, ''), ''),
			COALESCE(NULLIF(session.device_id, ''), ''),
			token.expires_at
		FROM session_tokens AS token
		JOIN agent_sessions AS session ON session.id = token.session_id
		WHERE token.token_hash = ? AND NOT EXISTS (SELECT 1 FROM chat_deletions d
			WHERE d.workspace_id = session.workspace_id AND d.deletion_key IN (
				'id:' || session.id, 'id:' || session.thread_id,
				'native:' || session.provider || ':' || json_extract(session.payload_json, '$.nativeSessionId')))`,
		hash).Scan(&identity.SessionID, &workspaceID, &deviceID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	if err != nil {
		return store.SessionTokenIdentity{}, err
	}
	expiry, parseErr := time.Parse(time.RFC3339Nano, expiresAt)
	if parseErr != nil || time.Now().UTC().After(expiry) {
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
