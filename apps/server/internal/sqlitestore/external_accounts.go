package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var _ store.ExternalAccountStore = (*Store)(nil)

// setupExternalAccounts creates the external account tables. Credentials
// never appear here: a provider app's client secret is sealed under
// "external-app:<id>" and an account's grant under
// "external-account:<id>" in the secret store.
func (s *Store) setupExternalAccounts(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS external_provider_apps (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			visibility TEXT NOT NULL,
			label TEXT NOT NULL,
			client_id TEXT NOT NULL,
			base_url TEXT NOT NULL DEFAULT '',
			created_via TEXT NOT NULL DEFAULT 'pasted',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS external_accounts (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			app_id TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			label TEXT NOT NULL,
			mode TEXT NOT NULL,
			status TEXT NOT NULL,
			status_detail TEXT NOT NULL DEFAULT '',
			subject TEXT NOT NULL DEFAULT '',
			display_name TEXT NOT NULL DEFAULT '',
			tenant TEXT NOT NULL DEFAULT '',
			granted_scopes TEXT NOT NULL DEFAULT '[]',
			keep_alive INTEGER NOT NULL DEFAULT 1,
			auth_time TEXT NOT NULL DEFAULT '',
			auth_expires_at TEXT NOT NULL DEFAULT '',
			access_expires_at TEXT NOT NULL DEFAULT '',
			refresh_expires_at TEXT NOT NULL DEFAULT '',
			last_refreshed_at TEXT NOT NULL DEFAULT '',
			last_refresh_by TEXT NOT NULL DEFAULT '',
			last_used_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_external_accounts_owner ON external_accounts (owner_user_id)`,
		`CREATE TABLE IF NOT EXISTS external_account_bindings (
			workspace_id TEXT NOT NULL,
			account_id TEXT NOT NULL REFERENCES external_accounts(id) ON DELETE CASCADE,
			granted_by TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (workspace_id, account_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_external_account_bindings_account ON external_account_bindings (account_id)`,
		// session_ref and device_ref name what used the account; the line is
		// an audit record of the account, not a row owned by that session.
		`CREATE TABLE IF NOT EXISTS external_account_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL REFERENCES external_accounts(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			session_ref TEXT NOT NULL DEFAULT '',
			device_ref TEXT NOT NULL DEFAULT '',
			actor_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_external_account_events_account ON external_account_events (account_id, id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite external accounts: %w", err)
		}
	}
	for _, column := range []string{"app_name", "tenant_name", "names_checked_at", "names_detail", "org_domain"} {
		if err := s.ensureColumn(ctx, "external_provider_apps", column,
			`ALTER TABLE external_provider_apps ADD COLUMN `+column+` TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "external_account_bindings", "resource_ids", `ALTER TABLE external_account_bindings ADD COLUMN resource_ids TEXT NOT NULL DEFAULT '[]'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "external_account_bindings", "access", `ALTER TABLE external_account_bindings ADD COLUMN access TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	return s.setupExternalCodeLogins(ctx)
}

func (s *Store) CreateExternalProviderApp(ctx context.Context, app store.ExternalProviderApp) (store.ExternalProviderApp, error) {
	if strings.TrimSpace(app.ID) == "" {
		app.ID = "xapp_" + uuid.NewString()
	}
	if app.Visibility == "" {
		app.Visibility = store.ExternalAppPersonal
	}
	if app.CreatedVia == "" {
		app.CreatedVia = "pasted"
	}
	now := formatTime(time.Now())
	app.CreatedAt, app.UpdatedAt = now, now
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO external_provider_apps
		(id, provider, owner_user_id, visibility, label, client_id, base_url, created_via, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		app.ID, app.Provider, app.OwnerUserID, string(app.Visibility), app.Label, app.ClientID, app.BaseURL, app.CreatedVia, now, now); err != nil {
		return store.ExternalProviderApp{}, fmt.Errorf("create external provider app: %w", err)
	}
	return app, nil
}

const externalAppColumns = `id, provider, owner_user_id, visibility, label, client_id, base_url, created_via,
	app_name, tenant_name, org_domain, names_checked_at, names_detail, created_at, updated_at`

func scanExternalApp(row interface{ Scan(dest ...any) error }) (store.ExternalProviderApp, error) {
	var app store.ExternalProviderApp
	var visibility string
	err := row.Scan(&app.ID, &app.Provider, &app.OwnerUserID, &visibility, &app.Label, &app.ClientID, &app.BaseURL, &app.CreatedVia,
		&app.AppName, &app.TenantName, &app.OrgDomain, &app.NamesCheckedAt, &app.NamesDetail, &app.CreatedAt, &app.UpdatedAt)
	app.Visibility = store.ExternalAppVisibility(visibility)
	return app, err
}

func (s *Store) GetExternalProviderApp(ctx context.Context, id string) (store.ExternalProviderApp, error) {
	app, err := scanExternalApp(s.reader().QueryRowContext(ctx, `SELECT `+externalAppColumns+` FROM external_provider_apps WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return store.ExternalProviderApp{}, store.ErrExternalAppNotFound
	}
	if err != nil {
		return store.ExternalProviderApp{}, fmt.Errorf("get external provider app: %w", err)
	}
	return app, nil
}

func (s *Store) ListExternalProviderApps(ctx context.Context, userID string) ([]store.ExternalProviderApp, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+externalAppColumns+` FROM external_provider_apps
		WHERE owner_user_id = ? OR visibility = ? ORDER BY label, id`, userID, string(store.ExternalAppInstance))
	if err != nil {
		return nil, fmt.Errorf("list external provider apps: %w", err)
	}
	defer rows.Close()
	apps := []store.ExternalProviderApp{}
	for rows.Next() {
		app, err := scanExternalApp(rows)
		if err != nil {
			return nil, fmt.Errorf("scan external provider app: %w", err)
		}
		apps = append(apps, app)
	}
	return apps, rows.Err()
}

func (s *Store) SetExternalProviderAppNames(ctx context.Context, id string, names store.ExternalAppNames) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE external_provider_apps
		SET app_name = ?, tenant_name = ?, org_domain = ?, names_checked_at = ?, names_detail = ? WHERE id = ?`,
		names.AppName, names.TenantName, names.OrgDomain, names.CheckedAt, names.Detail, id)
	if err != nil {
		return fmt.Errorf("record external provider app names: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrExternalAppNotFound
	}
	return nil
}

func (s *Store) DeleteExternalProviderApp(ctx context.Context, id string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM external_provider_apps WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete external provider app: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrExternalAppNotFound
	}
	return nil
}

const externalAccountColumns = `id, provider, app_id, owner_user_id, label, mode, status, status_detail, subject, display_name, tenant,
	granted_scopes, keep_alive, auth_time, auth_expires_at, access_expires_at, refresh_expires_at, last_refreshed_at, last_refresh_by,
	last_used_at, created_at, updated_at`

// SaveExternalAccount inserts or replaces the account by id. The bindings
// are kept separately and are not touched.
func (s *Store) SaveExternalAccount(ctx context.Context, account store.ExternalAccount) (store.ExternalAccount, error) {
	if strings.TrimSpace(account.ID) == "" {
		account.ID = "xacc_" + uuid.NewString()
	}
	if account.Mode == "" {
		account.Mode = store.ExternalCredentialServerHeld
	}
	if account.Status == "" {
		account.Status = store.ExternalAccountReady
	}
	now := formatTime(time.Now())
	if account.CreatedAt == "" {
		account.CreatedAt = now
	}
	account.UpdatedAt = now
	scopes, err := json.Marshal(nonNilStrings(account.GrantedScopes))
	if err != nil {
		return store.ExternalAccount{}, err
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO external_accounts
		(`+externalAccountColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider = excluded.provider, app_id = excluded.app_id, owner_user_id = excluded.owner_user_id,
			label = excluded.label, mode = excluded.mode, status = excluded.status, status_detail = excluded.status_detail,
			subject = excluded.subject, display_name = excluded.display_name, tenant = excluded.tenant,
			granted_scopes = excluded.granted_scopes, keep_alive = excluded.keep_alive, auth_time = excluded.auth_time,
			auth_expires_at = excluded.auth_expires_at, access_expires_at = excluded.access_expires_at,
			refresh_expires_at = excluded.refresh_expires_at, last_refreshed_at = excluded.last_refreshed_at,
			last_refresh_by = excluded.last_refresh_by, last_used_at = excluded.last_used_at, updated_at = excluded.updated_at`,
		account.ID, account.Provider, account.AppID, account.OwnerUserID, account.Label, string(account.Mode), string(account.Status),
		account.StatusDetail, account.Subject, account.DisplayName, account.Tenant, string(scopes), boolToInt(account.KeepAlive),
		account.AuthTime, account.AuthExpiresAt, account.AccessExpiresAt, account.RefreshExpiresAt, account.LastRefreshedAt,
		account.LastRefreshBy, account.LastUsedAt, account.CreatedAt, account.UpdatedAt); err != nil {
		return store.ExternalAccount{}, fmt.Errorf("save external account: %w", err)
	}
	return s.GetExternalAccount(ctx, account.ID)
}

func scanExternalAccount(row interface{ Scan(dest ...any) error }) (store.ExternalAccount, error) {
	var account store.ExternalAccount
	var mode, status, scopes string
	var keepAlive int
	err := row.Scan(&account.ID, &account.Provider, &account.AppID, &account.OwnerUserID, &account.Label, &mode, &status,
		&account.StatusDetail, &account.Subject, &account.DisplayName, &account.Tenant, &scopes, &keepAlive, &account.AuthTime,
		&account.AuthExpiresAt, &account.AccessExpiresAt, &account.RefreshExpiresAt, &account.LastRefreshedAt, &account.LastRefreshBy,
		&account.LastUsedAt, &account.CreatedAt, &account.UpdatedAt)
	if err != nil {
		return store.ExternalAccount{}, err
	}
	account.Mode = store.ExternalCredentialMode(mode)
	account.Status = store.ExternalAccountStatus(status)
	account.KeepAlive = keepAlive != 0
	if err := json.Unmarshal([]byte(scopes), &account.GrantedScopes); err != nil {
		return store.ExternalAccount{}, fmt.Errorf("decode granted scopes of %s: %w", account.ID, err)
	}
	return account, nil
}

func (s *Store) GetExternalAccount(ctx context.Context, id string) (store.ExternalAccount, error) {
	account, err := scanExternalAccount(s.reader().QueryRowContext(ctx, `SELECT `+externalAccountColumns+` FROM external_accounts WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return store.ExternalAccount{}, store.ErrExternalAccountNotFound
	}
	if err != nil {
		return store.ExternalAccount{}, fmt.Errorf("get external account: %w", err)
	}
	accounts := []store.ExternalAccount{account}
	if err := s.attachExternalAccountWorkspaces(ctx, accounts); err != nil {
		return store.ExternalAccount{}, err
	}
	return accounts[0], nil
}

func (s *Store) ListExternalAccounts(ctx context.Context, userID string) ([]store.ExternalAccount, error) {
	query := `SELECT ` + externalAccountColumns + ` FROM external_accounts`
	args := []any{}
	if userID != "" {
		query += ` WHERE owner_user_id = ?`
		args = append(args, userID)
	}
	rows, err := s.reader().QueryContext(ctx, query+` ORDER BY created_at, id`, args...)
	if err != nil {
		return nil, fmt.Errorf("list external accounts: %w", err)
	}
	defer rows.Close()
	accounts := []store.ExternalAccount{}
	for rows.Next() {
		account, err := scanExternalAccount(rows)
		if err != nil {
			return nil, fmt.Errorf("scan external account: %w", err)
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.attachExternalAccountWorkspaces(ctx, accounts); err != nil {
		return nil, err
	}
	return accounts, nil
}

// attachExternalAccountWorkspaces fills each account's WorkspaceIDs from
// the bindings, in place.
func (s *Store) attachExternalAccountWorkspaces(ctx context.Context, accounts []store.ExternalAccount) error {
	if len(accounts) == 0 {
		return nil
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT account_id, workspace_id FROM external_account_bindings ORDER BY created_at, workspace_id`)
	if err != nil {
		return fmt.Errorf("list external account bindings: %w", err)
	}
	defer rows.Close()
	byAccount := map[string][]string{}
	for rows.Next() {
		var accountID, workspaceID string
		if err := rows.Scan(&accountID, &workspaceID); err != nil {
			return err
		}
		byAccount[accountID] = append(byAccount[accountID], workspaceID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range accounts {
		accounts[index].WorkspaceIDs = byAccount[accounts[index].ID]
	}
	return nil
}

func (s *Store) DeleteExternalAccount(ctx context.Context, id string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM external_accounts WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete external account: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrExternalAccountNotFound
	}
	return nil
}

func (s *Store) SetWorkspaceExternalAccounts(ctx context.Context, workspaceID, userID string, accountIDs []string, resources ...map[string][]string) error {
	return s.withTx(ctx, func(tx *Store) error {
		before, err := tx.ListWorkspaceExternalAccounts(ctx, workspaceID)
		if err != nil {
			return err
		}
		previous := map[string][]string{}
		access := map[string]string{}
		for _, binding := range before {
			previous[binding.AccountID] = binding.ResourceIDs
			access[binding.AccountID] = binding.Access
		}
		selected := map[string][]string{}
		if len(resources) > 0 && resources[0] != nil {
			selected = resources[0]
		}
		cloudflareCount := 0
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM external_account_bindings
			WHERE workspace_id = ? AND account_id IN (SELECT id FROM external_accounts WHERE owner_user_id = ?)`,
			workspaceID, userID); err != nil {
			return fmt.Errorf("clear external account bindings: %w", err)
		}
		now := formatTime(time.Now())
		seenAccounts := map[string]bool{}
		for _, accountID := range accountIDs {
			if seenAccounts[accountID] {
				continue
			}
			seenAccounts[accountID] = true
			account, err := tx.GetExternalAccount(ctx, accountID)
			if err != nil {
				return err
			}
			if account.OwnerUserID != userID {
				return fmt.Errorf("%w: %s is not owned by the caller", store.ErrExternalAccountNotFound, accountID)
			}
			ids := previous[accountID]
			if value, ok := selected[accountID]; ok {
				ids = value
			}
			if account.Provider == "cloudflare" {
				cloudflareCount++
				if cloudflareCount > 1 {
					return errors.New("select one Cloudflare identity per workspace")
				}
				if len(ids) == 0 || len(ids) > 50 {
					return errors.New("select between 1 and 50 Cloudflare zones")
				}
				seen := map[string]bool{}
				clean := []string{}
				for _, id := range ids {
					if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
						return errors.New("invalid Cloudflare zone")
					}
					if !seen[id] {
						clean = append(clean, id)
						seen[id] = true
					}
				}
				ids = clean
			} else {
				ids = nil
			}
			encoded, _ := json.Marshal(nonNilStrings(ids))
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO external_account_bindings
				(workspace_id, account_id, granted_by, created_at, resource_ids, access) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(workspace_id, account_id) DO NOTHING`, workspaceID, accountID, userID, now, string(encoded), access[accountID]); err != nil {
				return fmt.Errorf("bind external account: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) ListWorkspaceExternalAccounts(ctx context.Context, workspaceID string) ([]store.ExternalAccountBinding, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT workspace_id, account_id, granted_by, created_at, resource_ids, access
		FROM external_account_bindings WHERE workspace_id = ? ORDER BY created_at, account_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace external accounts: %w", err)
	}
	defer rows.Close()
	bindings := []store.ExternalAccountBinding{}
	for rows.Next() {
		var binding store.ExternalAccountBinding
		var resources string
		if err := rows.Scan(&binding.WorkspaceID, &binding.AccountID, &binding.GrantedBy, &binding.CreatedAt, &resources, &binding.Access); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(resources), &binding.ResourceIDs); err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}

func (s *Store) SetExternalAccountBindingAccess(ctx context.Context, workspaceID, accountID, userID, access string) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE external_account_bindings SET access = ?
		WHERE workspace_id = ? AND account_id = ? AND granted_by = ?`, access, workspaceID, accountID, userID)
	if err != nil {
		return fmt.Errorf("set external account binding access: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrExternalAccountNotFound
	}
	return nil
}

func (s *Store) AppendExternalAccountEvent(ctx context.Context, event store.ExternalAccountEvent) error {
	if event.CreatedAt == "" {
		event.CreatedAt = formatTime(time.Now())
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO external_account_events
		(account_id, kind, detail, session_ref, device_ref, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.AccountID, event.Kind, event.Detail, event.SessionID, event.DeviceID, event.ActorID, event.CreatedAt); err != nil {
		return fmt.Errorf("append external account event: %w", err)
	}
	return nil
}

func (s *Store) ListExternalAccountEvents(ctx context.Context, accountID string, limit int) ([]store.ExternalAccountEvent, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id, account_id, kind, detail, session_ref, device_ref, actor_id, created_at
		FROM external_account_events WHERE account_id = ? ORDER BY id DESC LIMIT ?`, accountID, limit)
	if err != nil {
		return nil, fmt.Errorf("list external account events: %w", err)
	}
	defer rows.Close()
	events := []store.ExternalAccountEvent{}
	for rows.Next() {
		var event store.ExternalAccountEvent
		if err := rows.Scan(&event.ID, &event.AccountID, &event.Kind, &event.Detail, &event.SessionID, &event.DeviceID, &event.ActorID, &event.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
