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

// Session-scoped bearer tokens for the agent-facing MCP/CLI surface (CHAT-01).
// Plaintext is minted at dispatch, sent to the daemon inside the ephemeral
// run_session payload, and never persisted or logged; the store only keeps a
// SHA-256 hash.

const agentSessionTokenTTL = 30 * 24 * time.Hour

var ErrSessionTokenInvalid = errors.New("invalid or expired session token")

// MintAgentSessionToken creates a fresh token, persists only its hash, and
// returns the plaintext exactly once. Re-minting (re-dispatch) rotates the
// hash, invalidating any previously delivered token.
func (s *Store) MintAgentSessionToken(ctx context.Context, sessionID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("mint session token: %w", err)
	}
	plaintext := hex.EncodeToString(raw)
	hash := hashSessionToken(plaintext)
	now := time.Now().UTC()
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO agent_session_tokens
		(session_id, token_hash, created_at, last_used_at, expires_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			token_hash = excluded.token_hash,
			created_at = excluded.created_at,
			last_used_at = excluded.last_used_at,
			expires_at = excluded.expires_at`,
		sessionID, hash, formatTime(now), formatTime(now), formatTime(now.Add(agentSessionTokenTTL))); err != nil {
		return "", fmt.Errorf("persist session token: %w", err)
	}
	return plaintext, nil
}

func hashSessionToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// ResolveSessionToken validates a bearer token and returns the acting
// session's identity. Expired rows are deleted. Terminal sessions never have
// token rows (saveAgentSession deletes them in the same transaction).
func (s *Store) ResolveSessionToken(ctx context.Context, plaintext string) (store.SessionTokenIdentity, error) {
	plaintext = trimToken(plaintext)
	if plaintext == "" {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	var identity store.SessionTokenIdentity
	var workspaceID, deviceID sql.NullString
	var expiresAt string
	err := s.conn().QueryRowContext(ctx, `SELECT token.session_id,
			COALESCE(NULLIF(session.workspace_id, ''), ''),
			COALESCE(NULLIF(session.device_id, ''), ''),
			token.expires_at
		FROM agent_session_tokens AS token
		JOIN agent_sessions AS session ON session.id = token.session_id
		WHERE token.token_hash = ? AND NOT EXISTS (SELECT 1 FROM chat_deletions d
			WHERE d.workspace_id = session.workspace_id AND d.deletion_key IN (
				'id:' || session.id, 'id:' || session.thread_id,
				'native:' || session.provider || ':' || json_extract(session.payload_json, '$.nativeSessionId')))`,
		hashSessionToken(plaintext)).Scan(&identity.SessionID, &workspaceID, &deviceID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	if err != nil {
		return store.SessionTokenIdentity{}, err
	}
	expiry, parseErr := time.Parse(time.RFC3339Nano, expiresAt)
	if parseErr != nil || time.Now().UTC().After(expiry) {
		_, _ = s.conn().ExecContext(ctx, `DELETE FROM agent_session_tokens WHERE session_id = ?`, identity.SessionID)
		return store.SessionTokenIdentity{}, ErrSessionTokenInvalid
	}
	identity.WorkspaceID = workspaceID.String
	identity.DeviceID = deviceID.String
	_, _ = s.conn().ExecContext(ctx, `UPDATE agent_session_tokens SET last_used_at = ? WHERE session_id = ?`,
		formatTime(time.Now().UTC()), identity.SessionID)
	return identity, nil
}

func trimToken(value string) string {
	return strings.TrimSpace(value)
}
