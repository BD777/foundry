package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupConnectorPackages(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS connector_package_enablements (
			owner_user_id TEXT NOT NULL,
			package_kind TEXT NOT NULL,
			extension_id TEXT NOT NULL,
			repository_id TEXT NOT NULL,
			devices_json TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (owner_user_id, package_kind)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_connector_package_enablements_repository
			ON connector_package_enablements(repository_id)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("setup connector packages: %w", err)
		}
	}
	return nil
}

func (s *Store) GetConnectorPackage(ctx context.Context, ownerUserID, kind string) (store.ConnectorPackageEnablement, error) {
	return scanConnectorPackage(s.reader().QueryRowContext(ctx, `
		SELECT owner_user_id, package_kind, extension_id, repository_id, devices_json, updated_at
		FROM connector_package_enablements
		WHERE owner_user_id = ? AND package_kind = ?`, ownerUserID, kind))
}

func (s *Store) ListConnectorPackages(ctx context.Context, ownerUserID string) ([]store.ConnectorPackageEnablement, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT owner_user_id, package_kind, extension_id, repository_id, devices_json, updated_at
		FROM connector_package_enablements
		WHERE owner_user_id = ?
		ORDER BY package_kind`, ownerUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var packages []store.ConnectorPackageEnablement
	for rows.Next() {
		item, err := scanConnectorPackageRows(rows)
		if err != nil {
			return nil, err
		}
		packages = append(packages, item)
	}
	return packages, rows.Err()
}

func (s *Store) SaveConnectorPackage(ctx context.Context, packageEnablement store.ConnectorPackageEnablement) error {
	devices, err := json.Marshal(packageEnablement.Devices)
	if err != nil {
		return err
	}
	if packageEnablement.UpdatedAt == "" {
		packageEnablement.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err = s.conn().ExecContext(ctx, `
		INSERT INTO connector_package_enablements
			(owner_user_id, package_kind, extension_id, repository_id, devices_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_user_id, package_kind) DO UPDATE SET
			extension_id = excluded.extension_id,
			repository_id = excluded.repository_id,
			devices_json = excluded.devices_json,
			updated_at = excluded.updated_at`,
		packageEnablement.OwnerUserID, packageEnablement.Kind, packageEnablement.ExtensionID,
		packageEnablement.RepositoryID, string(devices), packageEnablement.UpdatedAt)
	return err
}

func (s *Store) DeleteConnectorPackage(ctx context.Context, ownerUserID, kind string) error {
	result, err := s.conn().ExecContext(ctx, `
		DELETE FROM connector_package_enablements
		WHERE owner_user_id = ? AND package_kind = ?`, ownerUserID, kind)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanConnectorPackage(row rowScanner) (store.ConnectorPackageEnablement, error) {
	var item store.ConnectorPackageEnablement
	item, err := scanConnectorPackageRows(row)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ConnectorPackageEnablement{}, store.ErrNotFound
	}
	return item, err
}

func scanConnectorPackageRows(row rowScanner) (store.ConnectorPackageEnablement, error) {
	var item store.ConnectorPackageEnablement
	var devices string
	if err := row.Scan(
		&item.OwnerUserID,
		&item.Kind,
		&item.ExtensionID,
		&item.RepositoryID,
		&devices,
		&item.UpdatedAt,
	); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	if err := json.Unmarshal([]byte(devices), &item.Devices); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	return item, nil
}
