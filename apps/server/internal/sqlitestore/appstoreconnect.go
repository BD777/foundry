package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var _ store.AppStoreConnectStore = (*Store)(nil)

func (s *Store) setupAppStoreConnect(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS appstoreconnect_keys (
			app_id TEXT PRIMARY KEY REFERENCES external_provider_apps(id) ON DELETE CASCADE,
			issuer_id TEXT NOT NULL,
			key_id TEXT NOT NULL,
			revoked_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_appstoreconnect_keys_issuer ON appstoreconnect_keys (issuer_id, key_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite app store connect: %w", err)
		}
	}
	return nil
}

func (s *Store) SaveAppStoreConnectKey(ctx context.Context, key store.AppStoreConnectKeyRecord) error {
	now := formatTime(time.Now())
	if key.CreatedAt == "" {
		key.CreatedAt = now
	}
	key.UpdatedAt = now
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO appstoreconnect_keys
		(app_id, issuer_id, key_id, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(app_id) DO UPDATE SET issuer_id = excluded.issuer_id, key_id = excluded.key_id,
			revoked_at = excluded.revoked_at, updated_at = excluded.updated_at`,
		key.AppID, key.IssuerID, key.KeyID, key.RevokedAt, key.CreatedAt, key.UpdatedAt); err != nil {
		return fmt.Errorf("save app store connect key: %w", err)
	}
	return nil
}

func (s *Store) GetAppStoreConnectKey(ctx context.Context, appID string) (store.AppStoreConnectKeyRecord, error) {
	var key store.AppStoreConnectKeyRecord
	err := s.reader().QueryRowContext(ctx, `SELECT app_id, issuer_id, key_id, revoked_at, created_at, updated_at
		FROM appstoreconnect_keys WHERE app_id = ?`, appID).Scan(
		&key.AppID, &key.IssuerID, &key.KeyID, &key.RevokedAt, &key.CreatedAt, &key.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.AppStoreConnectKeyRecord{}, store.ErrNotFound
	}
	if err != nil {
		return store.AppStoreConnectKeyRecord{}, fmt.Errorf("get app store connect key: %w", err)
	}
	return key, nil
}

func (s *Store) ListAppStoreConnectKeys(ctx context.Context, ownerUserID string) ([]store.AppStoreConnectKeyRecord, error) {
	query := `SELECT k.app_id, k.issuer_id, k.key_id, k.revoked_at, k.created_at, k.updated_at
		FROM appstoreconnect_keys k JOIN external_provider_apps a ON a.id = k.app_id`
	args := []any{}
	if ownerUserID != "" {
		query += ` WHERE a.owner_user_id = ?`
		args = append(args, ownerUserID)
	}
	rows, err := s.reader().QueryContext(ctx, query+` ORDER BY k.created_at, k.app_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("list app store connect keys: %w", err)
	}
	defer rows.Close()
	keys := []store.AppStoreConnectKeyRecord{}
	for rows.Next() {
		var key store.AppStoreConnectKeyRecord
		if err := rows.Scan(&key.AppID, &key.IssuerID, &key.KeyID, &key.RevokedAt, &key.CreatedAt, &key.UpdatedAt); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (s *Store) UpdateAppStoreConnectKey(ctx context.Context, app store.ExternalProviderApp, key store.AppStoreConnectKeyRecord) (store.ExternalProviderApp, error) {
	var saved store.ExternalProviderApp
	err := s.withTx(ctx, func(tx *Store) error {
		key.UpdatedAt = formatTime(time.Now())
		appResult, err := tx.conn().ExecContext(ctx, `UPDATE external_provider_apps SET label = ?, client_id = ?, updated_at = ? WHERE id = ?`,
			app.Label, app.ClientID, key.UpdatedAt, app.ID)
		if err != nil {
			return fmt.Errorf("update app store connect app: %w", err)
		}
		if count, _ := appResult.RowsAffected(); count == 0 {
			return store.ErrNotFound
		}
		keyResult, err := tx.conn().ExecContext(ctx, `UPDATE appstoreconnect_keys SET issuer_id = ?, key_id = ?, revoked_at = '',
			updated_at = ? WHERE app_id = ?`, key.IssuerID, key.KeyID, key.UpdatedAt, key.AppID)
		if err != nil {
			return fmt.Errorf("update app store connect key: %w", err)
		}
		if count, _ := keyResult.RowsAffected(); count == 0 {
			return store.ErrNotFound
		}
		saved, err = tx.GetExternalProviderApp(ctx, app.ID)
		return err
	})
	return saved, err
}

func (s *Store) RevokeAppStoreConnectKey(ctx context.Context, appID string, at time.Time) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE appstoreconnect_keys SET revoked_at = ?, updated_at = ? WHERE app_id = ?`,
		formatTime(at), formatTime(at), appID)
	if err != nil {
		return fmt.Errorf("revoke app store connect key: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) DeleteAppStoreConnectKey(ctx context.Context, appID string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM appstoreconnect_keys WHERE app_id = ?`, appID); err != nil {
		return fmt.Errorf("delete app store connect key: %w", err)
	}
	return nil
}
