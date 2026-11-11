package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Permission packages are separate from assistant settings so multiple
// assistants can later share the same resolver with different packages.
func (s *Store) setupPermissionPackages(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS permission_packages (
		id TEXT PRIMARY KEY,
		owner_user_id TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_permission_packages_owner ON permission_packages (owner_user_id, updated_at DESC)`); err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('personal_agents') WHERE name = 'permission_package_id'`).Scan(&present); err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	if present == 0 {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE personal_agents ADD COLUMN permission_package_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("migrate permission packages: %w", err)
		}
	}
	rows, err := s.conn().QueryContext(ctx, `SELECT a.user_id, a.permission_package_id, a.connector_opt_out
		FROM personal_agents a
		WHERE a.permission_package_id = '' OR NOT EXISTS (
			SELECT 1 FROM permission_packages p
			WHERE p.id = a.permission_package_id AND p.owner_user_id = a.user_id
		)`)
	if err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	type legacyAgent struct {
		userID, packageID, optOut string
	}
	legacy := []legacyAgent{}
	for rows.Next() {
		var agent legacyAgent
		if err := rows.Scan(&agent.userID, &agent.packageID, &agent.optOut); err != nil {
			_ = rows.Close()
			return fmt.Errorf("migrate permission packages: %w", err)
		}
		legacy = append(legacy, agent)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	for _, agent := range legacy {
		pkg, err := s.createDefaultPermissionPackage(ctx, agent.userID)
		if err != nil {
			return err
		}
		var disabled []string
		_ = json.Unmarshal([]byte(agent.optOut), &disabled)
		for _, accountID := range disabled {
			accountID = strings.TrimSpace(accountID)
			if accountID == "" {
				continue
			}
			pkg.ConnectorAccounts = append(pkg.ConnectorAccounts, store.ConnectorAccountPermission{
				AccountID: accountID,
				Level:     store.ConnectorAccessLevelOff,
			})
		}
		pkg, err = s.SavePermissionPackage(ctx, pkg)
		if err != nil {
			return err
		}
		if _, err := s.conn().ExecContext(ctx, `UPDATE personal_agents SET permission_package_id = ? WHERE user_id = ?`, pkg.ID, agent.userID); err != nil {
			return fmt.Errorf("migrate permission packages: %w", err)
		}
	}
	return nil
}

func (s *Store) createDefaultPermissionPackage(ctx context.Context, owner string) (store.PermissionPackage, error) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return store.PermissionPackage{}, errors.New("a permission package needs an owner")
	}
	pkg := permission.DefaultPackage(owner, paID("pp"))
	return s.SavePermissionPackage(ctx, pkg)
}

func (s *Store) GetPermissionPackage(ctx context.Context, ownerUserID, id string) (store.PermissionPackage, error) {
	var pkg store.PermissionPackage
	var payload string
	err := s.conn().QueryRowContext(ctx, `SELECT payload_json FROM permission_packages WHERE id = ? AND owner_user_id = ?`,
		strings.TrimSpace(id), strings.TrimSpace(ownerUserID)).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return pkg, store.ErrNotFound
	}
	if err != nil {
		return pkg, err
	}
	if err := json.Unmarshal([]byte(payload), &pkg); err != nil {
		return pkg, fmt.Errorf("permission package %s: %w", id, err)
	}
	if pkg.Owner != ownerUserID {
		return store.PermissionPackage{}, store.ErrNotFound
	}
	return permission.Normalize(pkg), nil
}

func (s *Store) SavePermissionPackage(ctx context.Context, pkg store.PermissionPackage) (store.PermissionPackage, error) {
	pkg = permission.Normalize(pkg)
	if pkg.ID == "" || pkg.Owner == "" {
		return store.PermissionPackage{}, errors.New("a permission package needs an id and owner")
	}
	if err := permission.Validate(pkg); err != nil {
		return store.PermissionPackage{}, err
	}
	payload, err := json.Marshal(pkg)
	if err != nil {
		return store.PermissionPackage{}, err
	}
	now := paNow()
	result, err := s.conn().ExecContext(ctx, `INSERT INTO permission_packages
		(id, owner_user_id, payload_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at
		WHERE permission_packages.owner_user_id = excluded.owner_user_id`,
		pkg.ID, pkg.Owner, string(payload), now, now)
	if err != nil {
		return store.PermissionPackage{}, fmt.Errorf("save permission package: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.PermissionPackage{}, store.ErrNotFound
	}
	return pkg, nil
}

var _ store.PermissionPackageStore = (*Store)(nil)
