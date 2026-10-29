package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupExternalCodeLogins creates the browser sign-ins a restart must not
// lose (DEV-091). No code, verifier or token is kept here: the verifier is
// sealed under "external-login:<id>" in the secret store.
func (s *Store) setupExternalCodeLogins(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS external_code_logins (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			target_account_id TEXT NOT NULL DEFAULT '',
			app_id TEXT NOT NULL DEFAULT '',
			redirect_uri TEXT NOT NULL,
			issuer TEXT NOT NULL,
			verification_uri TEXT NOT NULL DEFAULT '',
			phase TEXT NOT NULL,
			requested_scopes TEXT NOT NULL DEFAULT '[]',
			outcome TEXT NOT NULL DEFAULT '',
			account_id TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_external_code_logins_owner ON external_code_logins (owner_user_id, provider, outcome)`,
		`CREATE INDEX IF NOT EXISTS idx_external_code_logins_expiry ON external_code_logins (expires_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite external code logins: %w", err)
		}
	}
	return nil
}

// SaveExternalCodeLogin never moves a login back from "authorize" nor
// clears its app or authorization URL: a request ID adopted by a second
// dialog may be saved while the client is still being prepared.
func (s *Store) SaveExternalCodeLogin(ctx context.Context, login store.ExternalCodeLogin) error {
	scopes, err := json.Marshal(nonNilStrings(login.RequestedScopes))
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	_, err = s.conn().ExecContext(ctx, `INSERT INTO external_code_logins
		(id, provider, owner_user_id, request_id, target_account_id, app_id, redirect_uri, issuer, verification_uri, phase, requested_scopes, expires_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			request_id = excluded.request_id,
			app_id = COALESCE(NULLIF(excluded.app_id, ''), external_code_logins.app_id),
			verification_uri = COALESCE(NULLIF(excluded.verification_uri, ''), external_code_logins.verification_uri),
			phase = CASE WHEN external_code_logins.phase = 'authorize' THEN 'authorize' ELSE excluded.phase END,
			requested_scopes = excluded.requested_scopes,
			updated_at = excluded.updated_at
		WHERE external_code_logins.outcome = ''`,
		login.ID, login.Provider, login.OwnerUserID, login.RequestID, login.TargetAccountID, login.AppID, login.RedirectURI, login.Issuer,
		login.VerificationURI, login.Phase, string(scopes), login.ExpiresAt.UnixMilli(), now, now)
	if err != nil {
		return fmt.Errorf("save external code login: %w", err)
	}
	return nil
}

const externalCodeLoginColumns = `id, provider, owner_user_id, request_id, target_account_id, app_id, redirect_uri, issuer,
	verification_uri, phase, requested_scopes, outcome, account_id, detail, expires_at, updated_at`

func scanExternalCodeLogin(row interface{ Scan(dest ...any) error }) (store.ExternalCodeLogin, error) {
	var login store.ExternalCodeLogin
	var scopes string
	var expires, updated int64
	if err := row.Scan(&login.ID, &login.Provider, &login.OwnerUserID, &login.RequestID, &login.TargetAccountID, &login.AppID, &login.RedirectURI, &login.Issuer,
		&login.VerificationURI, &login.Phase, &scopes, &login.Outcome, &login.AccountID, &login.Detail, &expires, &updated); err != nil {
		return store.ExternalCodeLogin{}, err
	}
	_ = json.Unmarshal([]byte(scopes), &login.RequestedScopes)
	login.ExpiresAt, login.UpdatedAt = time.UnixMilli(expires), time.UnixMilli(updated)
	return login, nil
}

func (s *Store) GetExternalCodeLogin(ctx context.Context, id string) (store.ExternalCodeLogin, error) {
	login, err := scanExternalCodeLogin(s.reader().QueryRowContext(ctx, `SELECT `+externalCodeLoginColumns+` FROM external_code_logins WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return store.ExternalCodeLogin{}, store.ErrNotFound
	}
	return login, err
}

func (s *Store) ListPendingExternalCodeLogins(ctx context.Context, ownerUserID, provider string) ([]store.ExternalCodeLogin, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+externalCodeLoginColumns+` FROM external_code_logins
		WHERE owner_user_id = ? AND provider = ? AND outcome = '' ORDER BY created_at`, ownerUserID, provider)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logins []store.ExternalCodeLogin
	for rows.Next() {
		login, err := scanExternalCodeLogin(rows)
		if err != nil {
			return nil, err
		}
		logins = append(logins, login)
	}
	return logins, rows.Err()
}

func (s *Store) EndExternalCodeLogin(ctx context.Context, id string, from []string, to, accountID, detail string) (bool, error) {
	if len(from) == 0 {
		return false, errors.New("end external code login: no outcome to move from")
	}
	args := []any{to, accountID, detail, time.Now().UnixMilli(), id}
	for _, outcome := range from {
		args = append(args, outcome)
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE external_code_logins SET outcome = ?, account_id = ?, detail = ?, updated_at = ?
		WHERE id = ? AND outcome IN (?`+strings.Repeat(", ?", len(from)-1)+`)`, args...)
	if err != nil {
		return false, fmt.Errorf("end external code login: %w", err)
	}
	changed, err := result.RowsAffected()
	return changed == 1, err
}

func (s *Store) SupersedeExternalCodeLogins(ctx context.Context, ownerUserID, provider string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE external_code_logins SET outcome = 'superseded', updated_at = ?
		WHERE owner_user_id = ? AND provider = ? AND outcome = ''`, time.Now().UnixMilli(), ownerUserID, provider)
	if err != nil {
		return fmt.Errorf("supersede external code logins: %w", err)
	}
	return nil
}

func (s *Store) PruneExternalCodeLogins(ctx context.Context, before time.Time) ([]string, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT id FROM external_code_logins WHERE expires_at < ?`, before.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("prune external code logins: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return nil, err
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM external_code_logins WHERE expires_at < ?`, before.UnixMilli()); err != nil {
		return nil, fmt.Errorf("prune external code logins: %w", err)
	}
	return ids, nil
}
