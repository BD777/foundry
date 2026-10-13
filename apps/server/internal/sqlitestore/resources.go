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

// The resource inventory (store.ResourceStore): one row per source and one
// per instance. Package resources decides what the rows say; a source and
// its instances are always written together.
func (s *Store) setupResources(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS resource_sources (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			label TEXT NOT NULL DEFAULT '',
			online INTEGER NOT NULL DEFAULT 0,
			scanner_version INTEGER NOT NULL DEFAULT 0,
			detector_errors_json TEXT NOT NULL DEFAULT '[]',
			last_report_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS resource_instances (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL REFERENCES resource_sources(id) ON DELETE CASCADE,
			key TEXT NOT NULL,
			type TEXT NOT NULL,
			platform TEXT NOT NULL,
			name TEXT NOT NULL,
			state TEXT NOT NULL,
			state_reason TEXT NOT NULL DEFAULT '',
			stale INTEGER NOT NULL DEFAULT 0,
			readiness_json TEXT NOT NULL DEFAULT '{}',
			backends_json TEXT NOT NULL DEFAULT '[]',
			details_json TEXT NOT NULL DEFAULT '{}',
			detector TEXT NOT NULL DEFAULT '',
			discovered_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			gone_at TEXT NOT NULL DEFAULT '',
			UNIQUE (source_id, key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_resource_instances_type ON resource_instances (type, source_id)`,
		`CREATE INDEX IF NOT EXISTS idx_resource_instances_gone ON resource_instances (gone_at) WHERE gone_at <> ''`,
		// The owner's settings outlive the source's reports (and precede
		// its first one), so they are not a column of resource_sources.
		`CREATE TABLE IF NOT EXISTS resource_source_settings (
			source_id TEXT PRIMARY KEY,
			allow_remote_commands INTEGER NOT NULL DEFAULT 0,
			updated_by TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite resources: %w", err)
		}
	}
	return nil
}

const resourceInstanceColumns = `i.id, i.source_id, i.key, i.type, i.platform, i.name, i.state, i.state_reason,
	i.stale, i.readiness_json, i.backends_json, i.details_json, i.detector, i.discovered_at, i.last_seen_at,
	i.gone_at, s.kind, ` + resourceSourceLabel

// resourceSourceLabel is the device's Foundry name (renamed on the server),
// not the hostname the worker reported with its inventory.
const resourceSourceLabel = `COALESCE(NULLIF(d.label, ''), s.label)`

func (s *Store) ListResourceInstances(ctx context.Context, filter store.ResourceFilter) ([]store.ResourceInstance, error) {
	query := `SELECT ` + resourceInstanceColumns + `
		FROM resource_instances i JOIN resource_sources s ON s.id = i.source_id
		LEFT JOIN devices d ON d.id = s.id WHERE 1 = 1`
	var args []any
	if filter.SourceID != "" {
		query += ` AND i.source_id = ?`
		args = append(args, filter.SourceID)
	}
	if filter.Type != "" {
		query += ` AND i.type = ?`
		args = append(args, filter.Type)
	}
	if !filter.IncludeGone {
		query += ` AND i.state <> 'gone'`
	}
	query += ` ORDER BY i.type, ` + resourceSourceLabel + `, i.source_id, i.name, i.key`
	instances := []store.ResourceInstance{}
	err := scanRows(ctx, s.reader(), query, func(rows *sql.Rows) error {
		instance, err := scanResourceInstance(rows)
		if err == nil {
			instances = append(instances, instance)
		}
		return err
	}, args...)
	return instances, err
}

func scanResourceInstance(rows *sql.Rows) (store.ResourceInstance, error) {
	var (
		instance                     store.ResourceInstance
		stale                        int
		readiness, backends, details string
	)
	if err := rows.Scan(&instance.ID, &instance.Source.ID, &instance.Key, &instance.Type, &instance.Platform,
		&instance.Name, &instance.State, &instance.StateReason, &stale, &readiness, &backends, &details,
		&instance.Detector, &instance.DiscoveredAt, &instance.LastSeenAt, &instance.GoneAt,
		&instance.Source.Kind, &instance.Source.Label); err != nil {
		return instance, err
	}
	instance.Stale = stale != 0
	if err := json.Unmarshal([]byte(readiness), &instance.Readiness); err != nil {
		return instance, fmt.Errorf("resource %s readiness: %w", instance.ID, err)
	}
	if err := json.Unmarshal([]byte(backends), &instance.Backends); err != nil {
		return instance, fmt.Errorf("resource %s backends: %w", instance.ID, err)
	}
	if instance.Backends == nil {
		instance.Backends = []store.ResourceBackend{}
	}
	if err := json.Unmarshal([]byte(details), &instance.Details); err != nil {
		return instance, fmt.Errorf("resource %s details: %w", instance.ID, err)
	}
	if len(instance.Details) == 0 {
		instance.Details = nil
	}
	return instance, nil
}

func (s *Store) ListResourceSources(ctx context.Context) ([]store.ResourceSourceStatus, error) {
	sources := []store.ResourceSourceStatus{}
	err := scanRows(ctx, s.reader(), `SELECT s.id, s.kind, `+resourceSourceLabel+`, s.online, s.scanner_version, s.detector_errors_json,
		s.last_report_at, COALESCE(t.allow_remote_commands, 0)
		FROM resource_sources s LEFT JOIN resource_source_settings t ON t.source_id = s.id
		LEFT JOIN devices d ON d.id = s.id
		ORDER BY `+resourceSourceLabel+`, s.id`, func(rows *sql.Rows) error {
		var (
			source         store.ResourceSourceStatus
			online, remote int
			detectorErrors string
		)
		if err := rows.Scan(&source.ID, &source.Kind, &source.Label, &online, &source.ScannerVersion,
			&detectorErrors, &source.LastReportAt, &remote); err != nil {
			return err
		}
		source.Online = online != 0
		source.AllowRemoteCommands = remote != 0
		if err := json.Unmarshal([]byte(detectorErrors), &source.DetectorErrors); err != nil {
			return fmt.Errorf("resource source %s detector errors: %w", source.ID, err)
		}
		if source.DetectorErrors == nil {
			source.DetectorErrors = []store.ResourceDetectorError{}
		}
		sources = append(sources, source)
		return nil
	})
	return sources, err
}

func (s *Store) ReplaceSourceResources(ctx context.Context, source store.ResourceSourceStatus, instances []store.ResourceInstance) error {
	detectorErrors, err := json.Marshal(nonNil(source.DetectorErrors))
	if err != nil {
		return err
	}
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO resource_sources
			(id, kind, label, online, scanner_version, detector_errors_json, last_report_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, online = excluded.online,
				scanner_version = excluded.scanner_version, detector_errors_json = excluded.detector_errors_json,
				last_report_at = excluded.last_report_at`,
			source.ID, source.Kind, source.Label, boolInt(source.Online), source.ScannerVersion,
			string(detectorErrors), source.LastReportAt); err != nil {
			return fmt.Errorf("save resource source: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM resource_instances WHERE source_id = ?`, source.ID); err != nil {
			return fmt.Errorf("replace resources: %w", err)
		}
		for _, instance := range instances {
			readiness, err := json.Marshal(instance.Readiness)
			if err != nil {
				return err
			}
			backends, err := json.Marshal(nonNil(instance.Backends))
			if err != nil {
				return err
			}
			details, err := json.Marshal(instance.Details)
			if err != nil {
				return err
			}
			if instance.Details == nil {
				details = []byte("{}")
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO resource_instances
				(id, source_id, key, type, platform, name, state, state_reason, stale, readiness_json, backends_json,
				 details_json, detector, discovered_at, last_seen_at, gone_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				instance.ID, source.ID, instance.Key, instance.Type, instance.Platform, instance.Name, instance.State,
				instance.StateReason, boolInt(instance.Stale), string(readiness), string(backends), string(details),
				instance.Detector, instance.DiscoveredAt, instance.LastSeenAt, instance.GoneAt); err != nil {
				return fmt.Errorf("save resource %s: %w", instance.Key, err)
			}
		}
		return nil
	})
}

func (s *Store) DeleteGoneResources(ctx context.Context, before time.Time) (int64, error) {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM resource_instances WHERE gone_at <> '' AND gone_at < ?`, formatTime(before))
	if err != nil {
		return 0, fmt.Errorf("delete gone resources: %w", err)
	}
	return result.RowsAffected()
}

func (s *Store) ResourceSourceSettings(ctx context.Context, sourceID string) (store.ResourceSourceSettings, error) {
	var remote int
	err := s.reader().QueryRowContext(ctx, `SELECT allow_remote_commands FROM resource_source_settings WHERE source_id = ?`,
		sourceID).Scan(&remote)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ResourceSourceSettings{}, nil
	}
	if err != nil {
		return store.ResourceSourceSettings{}, fmt.Errorf("read resource settings: %w", err)
	}
	return store.ResourceSourceSettings{AllowRemoteCommands: remote != 0}, nil
}

func (s *Store) SetResourceSourceSettings(ctx context.Context, sourceID string, settings store.ResourceSourceSettings, byUserID string) error {
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO resource_source_settings
		(source_id, allow_remote_commands, updated_by, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(source_id) DO UPDATE SET allow_remote_commands = excluded.allow_remote_commands,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		sourceID, boolInt(settings.AllowRemoteCommands), byUserID, formatTime(time.Now())); err != nil {
		return fmt.Errorf("save resource settings: %w", err)
	}
	return nil
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
