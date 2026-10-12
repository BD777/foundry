package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var _ store.FeishuGatewayStore = (*Store)(nil)

// setupFeishuGateway creates the Feishu gateway's tables: grants (hashes of
// the stand-in handles a session's device holds), the audit of every call,
// and the apps whose secret should be rotated because devices held it
// before the gateway existed. That last list is filled once, when the table
// is created: every Feishu app then known had its secret sent to the
// devices of sessions that used it.
func (s *Store) setupFeishuGateway(ctx context.Context) error {
	var existing int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'feishu_gateway_rotate_apps'`).Scan(&existing); err != nil {
		return fmt.Errorf("inspect feishu gateway tables: %w", err)
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS feishu_gateway_grants (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			app_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			app_hash TEXT NOT NULL UNIQUE,
			user_hash TEXT NOT NULL UNIQUE,
			tenant_hash TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_gateway_grants_session ON feishu_gateway_grants (session_id)`,
		// The audit names who and what by reference; it is not owned by the
		// session, account or device it mentions, so it outlives them.
		`CREATE TABLE IF NOT EXISTS feishu_gateway_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			user_ref TEXT NOT NULL DEFAULT '',
			session_ref TEXT NOT NULL DEFAULT '',
			device_ref TEXT NOT NULL DEFAULT '',
			workspace_ref TEXT NOT NULL DEFAULT '',
			account_ref TEXT NOT NULL DEFAULT '',
			app_ref TEXT NOT NULL DEFAULT '',
			identity TEXT NOT NULL DEFAULT '',
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			status INTEGER NOT NULL,
			bytes_in INTEGER NOT NULL DEFAULT 0,
			bytes_out INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			outcome TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_gateway_requests_user ON feishu_gateway_requests (user_ref, id)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_gateway_requests_session ON feishu_gateway_requests (session_ref, id)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_gateway_requests_at ON feishu_gateway_requests (at)`,
		`CREATE TABLE IF NOT EXISTS feishu_gateway_rotate_apps (
			app_id TEXT PRIMARY KEY,
			noticed_at TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite feishu gateway: %w", err)
		}
	}
	if existing == 0 {
		if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO feishu_gateway_rotate_apps (app_id, noticed_at)
			SELECT id, ? FROM external_provider_apps WHERE provider = 'feishu'`, formatTime(time.Now())); err != nil {
			return fmt.Errorf("list feishu apps whose secret devices held: %w", err)
		}
	}
	return nil
}

func (s *Store) CreateFeishuGatewayGrant(ctx context.Context, grant store.FeishuGatewayGrant) error {
	if strings.TrimSpace(grant.ID) == "" {
		grant.ID = "fgg_" + uuid.NewString()
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO feishu_gateway_grants
		(id, session_id, account_id, app_id, device_id, workspace_id, user_id, app_hash, user_hash, tenant_hash, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		grant.ID, grant.SessionID, grant.AccountID, grant.AppID, grant.DeviceID, grant.WorkspaceID, grant.UserID,
		grant.AppHash, grant.UserHash, grant.TenantHash, formatTime(time.Now())); err != nil {
		return fmt.Errorf("create feishu gateway grant: %w", err)
	}
	return nil
}

func (s *Store) FindFeishuGatewayGrant(ctx context.Context, kind, hash string) (store.FeishuGatewayGrant, error) {
	column := map[string]string{store.FeishuHandleApp: "app_hash", store.FeishuHandleUser: "user_hash", store.FeishuHandleTenant: "tenant_hash"}[kind]
	if column == "" || hash == "" {
		return store.FeishuGatewayGrant{}, store.ErrNotFound
	}
	var grant store.FeishuGatewayGrant
	err := s.reader().QueryRowContext(ctx, `SELECT id, session_id, account_id, app_id, device_id, workspace_id, user_id, app_hash, user_hash, tenant_hash, created_at
		FROM feishu_gateway_grants WHERE `+column+` = ?`, hash).Scan(
		&grant.ID, &grant.SessionID, &grant.AccountID, &grant.AppID, &grant.DeviceID, &grant.WorkspaceID, &grant.UserID,
		&grant.AppHash, &grant.UserHash, &grant.TenantHash, &grant.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.FeishuGatewayGrant{}, store.ErrNotFound
	}
	if err != nil {
		return store.FeishuGatewayGrant{}, fmt.Errorf("find feishu gateway grant: %w", err)
	}
	return grant, nil
}

func (s *Store) DeleteFeishuGatewayGrant(ctx context.Context, id string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_gateway_grants WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete feishu gateway grant: %w", err)
	}
	return nil
}

func (s *Store) PruneFeishuGatewayGrants(ctx context.Context) (int, error) {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_gateway_grants WHERE session_id NOT IN (
		SELECT id FROM agent_sessions WHERE status IN ('queued', 'running', 'blocked'))`)
	if err != nil {
		return 0, fmt.Errorf("prune feishu gateway grants: %w", err)
	}
	removed, _ := result.RowsAffected()
	return int(removed), nil
}

func (s *Store) AppendFeishuGatewayRequest(ctx context.Context, request store.FeishuGatewayRequest) error {
	if request.At == "" {
		request.At = formatTime(time.Now())
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO feishu_gateway_requests
		(at, user_ref, session_ref, device_ref, workspace_ref, account_ref, app_ref, identity, method, path, status, bytes_in, bytes_out, duration_ms, outcome)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		request.At, request.UserID, request.SessionID, request.DeviceID, request.WorkspaceID, request.AccountID, request.AppID,
		request.Identity, request.Method, request.Path, request.Status, request.BytesIn, request.BytesOut, request.DurationMS, request.Outcome); err != nil {
		return fmt.Errorf("record feishu gateway request: %w", err)
	}
	return nil
}

func (s *Store) ListFeishuGatewayRequests(ctx context.Context, filter store.FeishuGatewayRequestFilter) ([]store.FeishuGatewayRequest, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT id, at, user_ref, session_ref, device_ref, workspace_ref, account_ref, app_ref, identity, method, path, status, bytes_in, bytes_out, duration_ms, outcome
		FROM feishu_gateway_requests WHERE 1 = 1`
	var args []any
	for _, condition := range []struct{ column, value string }{
		{"user_ref", filter.UserID}, {"session_ref", filter.SessionID}, {"account_ref", filter.AccountID},
	} {
		if condition.value != "" {
			query += " AND " + condition.column + " = ?"
			args = append(args, condition.value)
		}
	}
	if filter.BeforeID > 0 {
		query += " AND id < ?"
		args = append(args, filter.BeforeID)
	}
	query += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.reader().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list feishu gateway requests: %w", err)
	}
	defer rows.Close()
	requests := []store.FeishuGatewayRequest{}
	for rows.Next() {
		var request store.FeishuGatewayRequest
		if err := rows.Scan(&request.ID, &request.At, &request.UserID, &request.SessionID, &request.DeviceID, &request.WorkspaceID,
			&request.AccountID, &request.AppID, &request.Identity, &request.Method, &request.Path, &request.Status,
			&request.BytesIn, &request.BytesOut, &request.DurationMS, &request.Outcome); err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *Store) PruneFeishuGatewayRequests(ctx context.Context, before time.Time) (int, error) {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_gateway_requests WHERE at < ?`, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("prune feishu gateway requests: %w", err)
	}
	removed, _ := result.RowsAffected()
	return int(removed), nil
}

func (s *Store) FeishuAppsToRotate(ctx context.Context) (map[string]string, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT app_id, noticed_at FROM feishu_gateway_rotate_apps`)
	if err != nil {
		return nil, fmt.Errorf("list feishu apps to rotate: %w", err)
	}
	defer rows.Close()
	apps := map[string]string{}
	for rows.Next() {
		var appID, noticedAt string
		if err := rows.Scan(&appID, &noticedAt); err != nil {
			return nil, err
		}
		apps[appID] = noticedAt
	}
	return apps, rows.Err()
}

func (s *Store) ClearFeishuAppRotation(ctx context.Context, appID string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_gateway_rotate_apps WHERE app_id = ?`, appID); err != nil {
		return fmt.Errorf("clear feishu app rotation: %w", err)
	}
	return nil
}
