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
	// selected_json empty means the selection is devices_json (rows written
	// before the selection was kept apart from the installed devices).
	for _, column := range []struct{ name, definition string }{
		{"selected_json", "selected_json TEXT NOT NULL DEFAULT ''"},
		{"states_json", "states_json TEXT NOT NULL DEFAULT '{}'"},
	} {
		var present int
		if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('connector_package_enablements') WHERE name = ?`, column.name).Scan(&present); err != nil {
			return fmt.Errorf("setup connector packages: %w", err)
		}
		if present > 0 {
			continue
		}
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE connector_package_enablements ADD COLUMN `+column.definition); err != nil {
			return fmt.Errorf("setup connector packages: %w", err)
		}
	}
	return nil
}

const connectorPackageColumns = `owner_user_id, package_kind, extension_id, repository_id, devices_json, selected_json, states_json, updated_at`

func (s *Store) GetConnectorPackage(ctx context.Context, ownerUserID, kind string) (store.ConnectorPackageEnablement, error) {
	return scanConnectorPackage(s.reader().QueryRowContext(ctx, `
		SELECT `+connectorPackageColumns+`
		FROM connector_package_enablements
		WHERE owner_user_id = ? AND package_kind = ?`, ownerUserID, kind))
}

func (s *Store) ListConnectorPackages(ctx context.Context, ownerUserID string) ([]store.ConnectorPackageEnablement, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT `+connectorPackageColumns+`
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

func (s *Store) ListAllConnectorPackages(ctx context.Context) ([]store.ConnectorPackageEnablement, error) {
	rows, err := s.reader().QueryContext(ctx, `
		SELECT `+connectorPackageColumns+`
		FROM connector_package_enablements
		ORDER BY owner_user_id, package_kind`)
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
	selected, err := json.Marshal(packageEnablement.Selected)
	if err != nil {
		return err
	}
	if packageEnablement.Selected == nil {
		selected = nil
	}
	states, err := json.Marshal(packageEnablement.States)
	if err != nil {
		return err
	}
	if packageEnablement.States == nil {
		states = []byte("{}")
	}
	if packageEnablement.UpdatedAt == "" {
		packageEnablement.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err = s.conn().ExecContext(ctx, `
		INSERT INTO connector_package_enablements
			(owner_user_id, package_kind, extension_id, repository_id, devices_json, selected_json, states_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_user_id, package_kind) DO UPDATE SET
			extension_id = excluded.extension_id,
			repository_id = excluded.repository_id,
			devices_json = excluded.devices_json,
			selected_json = excluded.selected_json,
			states_json = excluded.states_json,
			updated_at = excluded.updated_at`,
		packageEnablement.OwnerUserID, packageEnablement.Kind, packageEnablement.ExtensionID,
		packageEnablement.RepositoryID, string(devices), string(selected), string(states), packageEnablement.UpdatedAt)
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
	var devices, selected, states string
	if err := row.Scan(
		&item.OwnerUserID,
		&item.Kind,
		&item.ExtensionID,
		&item.RepositoryID,
		&devices,
		&selected,
		&states,
		&item.UpdatedAt,
	); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	if err := json.Unmarshal([]byte(devices), &item.Devices); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	if selected == "" {
		item.Selected = append([]string(nil), item.Devices...)
	} else if err := json.Unmarshal([]byte(selected), &item.Selected); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	if err := json.Unmarshal([]byte(states), &item.States); err != nil {
		return store.ConnectorPackageEnablement{}, err
	}
	return item, nil
}
