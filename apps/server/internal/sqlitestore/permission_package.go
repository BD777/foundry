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
	// Every assistant has a package; one created before packages existed
	// gets the default, its old connector opt-outs turned off.
	rows, err := s.conn().QueryContext(ctx, `SELECT a.id, a.owner_user_id, a.permission_package_id, a.connector_opt_out
		FROM assistants a
		WHERE a.permission_package_id = '' OR NOT EXISTS (
			SELECT 1 FROM permission_packages p
			WHERE p.id = a.permission_package_id AND p.owner_user_id = a.owner_user_id
		)`)
	if err != nil {
		return fmt.Errorf("migrate permission packages: %w", err)
	}
	type legacyAgent struct {
		id, userID, packageID, optOut string
	}
	legacy := []legacyAgent{}
	for rows.Next() {
		var agent legacyAgent
		if err := rows.Scan(&agent.id, &agent.userID, &agent.packageID, &agent.optOut); err != nil {
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
		if _, err := s.conn().ExecContext(ctx, `UPDATE assistants SET permission_package_id = ? WHERE id = ?`, pkg.ID, agent.id); err != nil {
			return fmt.Errorf("migrate permission packages: %w", err)
		}
	}
	return s.migrateIdentityResources(ctx)
}

// migrateIdentityResources rewrites packages saved before DEV-191 P0. The
// devices whose resources the assistant could lease directly
// (devicesResources.directLeaseAllowed) become scope listed with the
// identity resources known on those devices; without any, the default
// assistant's package keeps today's reach (scope all) and a later
// assistant's lists none. The skills rule, which now follows the
// workspace, is dropped.
func (s *Store) migrateIdentityResources(ctx context.Context) error {
	rows, err := s.conn().QueryContext(ctx, `SELECT p.id, p.payload_json,
			COALESCE((SELECT max(a.is_default) FROM assistants a WHERE a.permission_package_id = p.id), 1)
		FROM permission_packages p
		WHERE json_type(p.payload_json, '$.devicesResources') IS NOT NULL OR json_type(p.payload_json, '$.skills') IS NOT NULL`)
	if err != nil {
		return fmt.Errorf("migrate permission package resources: %w", err)
	}
	type legacyPackage struct {
		id, payload string
		isDefault   bool
	}
	legacy := []legacyPackage{}
	for rows.Next() {
		var row legacyPackage
		if err := rows.Scan(&row.id, &row.payload, &row.isDefault); err != nil {
			_ = rows.Close()
			return fmt.Errorf("migrate permission package resources: %w", err)
		}
		legacy = append(legacy, row)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("migrate permission package resources: %w", err)
	}
	for _, row := range legacy {
		var pkg store.PermissionPackage
		var old struct {
			DevicesResources struct {
				DirectLeaseAllowed []string `json:"directLeaseAllowed"`
			} `json:"devicesResources"`
		}
		if err := json.Unmarshal([]byte(row.payload), &pkg); err != nil {
			return fmt.Errorf("migrate permission package %s: %w", row.id, err)
		}
		if err := json.Unmarshal([]byte(row.payload), &old); err != nil {
			return fmt.Errorf("migrate permission package %s: %w", row.id, err)
		}
		resources, err := s.identityResourcesOn(ctx, old.DevicesResources.DirectLeaseAllowed)
		if err != nil {
			return fmt.Errorf("migrate permission package %s: %w", row.id, err)
		}
		pkg.IdentityResources.Scope = store.PermissionListScopeAll
		if len(old.DevicesResources.DirectLeaseAllowed) > 0 || !row.isDefault {
			pkg.IdentityResources.Scope = store.PermissionListScopeListed
		}
		pkg.IdentityResources.Allowed = append(pkg.IdentityResources.Allowed, resources...)
		payload, err := json.Marshal(permission.Normalize(pkg))
		if err != nil {
			return err
		}
		if _, err := s.conn().ExecContext(ctx, `UPDATE permission_packages SET payload_json = ? WHERE id = ?`, string(payload), row.id); err != nil {
			return fmt.Errorf("migrate permission package %s: %w", row.id, err)
		}
	}
	return nil
}

// identityResourcesOn lists the identity resources known on the devices.
// Before resources are set up (a new database) there are none.
func (s *Store) identityResourcesOn(ctx context.Context, deviceIDs []string) ([]string, error) {
	if len(deviceIDs) == 0 {
		return nil, nil
	}
	var tables int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'resource_instances'`).Scan(&tables); err != nil || tables == 0 {
		return nil, err
	}
	devices, err := json.Marshal(deviceIDs)
	if err != nil {
		return nil, err
	}
	types, err := json.Marshal(permission.IdentityResourceTypes())
	if err != nil {
		return nil, err
	}
	rows, err := s.conn().QueryContext(ctx, `SELECT id FROM resource_instances
		WHERE source_id IN (SELECT value FROM json_each(?)) AND type IN (SELECT value FROM json_each(?))
		ORDER BY source_id, key`, string(devices), string(types))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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
