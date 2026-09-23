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
	"github.com/google/uuid"
)

// profileColumns lists the projected columns in scanProfile's order.
const profileColumns = `id, runtime, label, auth_mode, connection_type, base_url, model, models, prompt_prefix,
	claude_effort, claude_permission_mode,
	codex_reasoning_effort, codex_sandbox_mode, codex_approval_policy, codex_speed,
	owner_user_id, updated_at`

// setupProfiles creates the control-plane profile tables. Profiles are
// server-owned and global — they carry no device and no workspace — while
// device_profiles records which of them a given device is allowed to run.
// Credentials never appear here: they live in the sealed secret store under
// the id "agent-profile:<profileID>".
func (s *Store) setupProfiles(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS profiles (
			id TEXT PRIMARY KEY,
			runtime TEXT NOT NULL,
			label TEXT NOT NULL,
			auth_mode TEXT NOT NULL DEFAULT 'custom',
			connection_type TEXT NOT NULL,
			base_url TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			models TEXT NOT NULL DEFAULT '[]',
			prompt_prefix TEXT NOT NULL DEFAULT '',
			claude_effort TEXT NOT NULL DEFAULT '',
			claude_permission_mode TEXT NOT NULL DEFAULT '',
			codex_reasoning_effort TEXT NOT NULL DEFAULT '',
			codex_sandbox_mode TEXT NOT NULL DEFAULT '',
			codex_approval_policy TEXT NOT NULL DEFAULT '',
			codex_speed TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_profiles (
			device_id TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, profile_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_device_profiles_profile ON device_profiles (profile_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite profiles: %w", err)
		}
	}
	if err := s.ensureColumn(ctx, "profiles", "auth_mode", `ALTER TABLE profiles ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'custom'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "profiles", "models", `ALTER TABLE profiles ADD COLUMN models TEXT NOT NULL DEFAULT '[]'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "profiles", "owner_user_id", `ALTER TABLE profiles ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	return nil
}

// ListProfiles returns every server profile. HasCredential stays false: the
// secret store is the HTTP layer's concern, and this layer never reads it.
func (s *Store) ListProfiles(ctx context.Context) ([]store.ProfileDefinition, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT `+profileColumns+` FROM profiles ORDER BY label, id`)
	if err != nil {
		return nil, fmt.Errorf("list profiles: %w", err)
	}
	defer rows.Close()
	result := []store.ProfileDefinition{}
	for rows.Next() {
		profile, err := scanProfile(rows)
		if err != nil {
			return nil, fmt.Errorf("list profiles: %w", err)
		}
		result = append(result, profile)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list profiles: %w", err)
	}
	return result, nil
}

// GetProfile loads one server profile, reporting store.ErrProfileNotFound when
// no row carries the id.
func (s *Store) GetProfile(ctx context.Context, id string) (store.ProfileDefinition, error) {
	row := s.conn().QueryRowContext(ctx, `SELECT `+profileColumns+` FROM profiles WHERE id = ?`, id)
	profile, err := scanProfile(row)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ProfileDefinition{}, fmt.Errorf("%w: %s", store.ErrProfileNotFound, id)
	}
	if err != nil {
		return store.ProfileDefinition{}, fmt.Errorf("load profile %s: %w", id, err)
	}
	return profile, nil
}

// SaveProfile is an upsert primitive: an empty input.ID mints prof_<uuid>, and
// a supplied id inserts when free or overwrites when taken, leaving created_at
// on the original row while updated_at moves. Deciding whether a given id may
// be claimed is policy and belongs to the caller. The write-only input.APIKey
// is deliberately ignored: credential material belongs to the sealed secret
// store, never to this table.
func (s *Store) SaveProfile(ctx context.Context, input store.SaveProfileInput) (store.ProfileDefinition, error) {
	var result store.ProfileDefinition
	now := formatTime(time.Now())
	err := s.withTx(ctx, func(tx *Store) error {
		id := strings.TrimSpace(input.ID)
		if id == "" {
			id = "prof_" + uuid.NewString()
		}
		_, err := tx.conn().ExecContext(ctx, `
			INSERT INTO profiles (
				id, runtime, label, auth_mode, connection_type, base_url, model, models, prompt_prefix,
				claude_effort, claude_permission_mode,
				codex_reasoning_effort, codex_sandbox_mode, codex_approval_policy, codex_speed,
				owner_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				runtime = excluded.runtime,
				label = excluded.label,
				auth_mode = excluded.auth_mode,
				connection_type = excluded.connection_type,
				base_url = excluded.base_url,
				model = excluded.model,
				models = excluded.models,
				prompt_prefix = excluded.prompt_prefix,
				claude_effort = excluded.claude_effort,
				claude_permission_mode = excluded.claude_permission_mode,
				codex_reasoning_effort = excluded.codex_reasoning_effort,
				codex_sandbox_mode = excluded.codex_sandbox_mode,
				codex_approval_policy = excluded.codex_approval_policy,
				codex_speed = excluded.codex_speed,
				updated_at = excluded.updated_at`,
			id, input.Runtime, input.Label, input.AuthMode, input.ConnectionType, input.BaseURL, input.Model, encodeModelList(input.Models), input.PromptPrefix,
			input.ClaudeEffort, input.ClaudePermissionMode,
			input.CodexReasoningEffort, input.CodexSandboxMode, input.CodexApprovalPolicy, input.CodexSpeed,
			input.OwnerUserID, now, now)
		if err != nil {
			return fmt.Errorf("save profile %s: %w", id, err)
		}
		saved, err := tx.GetProfile(ctx, id)
		if err != nil {
			return err
		}
		result = saved
		return nil
	})
	if err != nil {
		return store.ProfileDefinition{}, err
	}
	return result, nil
}

// DeleteProfile removes a profile and the device bindings that referenced it
// in one transaction, so no device keeps an entry pointing at a gone profile.
func (s *Store) DeleteProfile(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `DELETE FROM profiles WHERE id = ?`, id)
		if err != nil {
			return fmt.Errorf("delete profile %s: %w", id, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("delete profile %s: %w", id, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: %s", store.ErrProfileNotFound, id)
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_profiles WHERE profile_id = ?`, id); err != nil {
			return fmt.Errorf("delete profile %s bindings: %w", id, err)
		}
		return nil
	})
}

// ListDeviceProfiles returns the bindings for one device, or every device's
// bindings when deviceID is empty.
func (s *Store) ListDeviceProfiles(ctx context.Context, deviceID string) ([]store.DeviceProfileBinding, error) {
	query := `SELECT device_id, profile_id, enabled FROM device_profiles ORDER BY device_id, profile_id`
	args := []any{}
	if deviceID = strings.TrimSpace(deviceID); deviceID != "" {
		query = `SELECT device_id, profile_id, enabled FROM device_profiles WHERE device_id = ? ORDER BY profile_id`
		args = append(args, deviceID)
	}
	rows, err := s.conn().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list device profiles: %w", err)
	}
	defer rows.Close()
	result := []store.DeviceProfileBinding{}
	for rows.Next() {
		var binding store.DeviceProfileBinding
		if err := rows.Scan(&binding.DeviceID, &binding.ProfileID, &binding.Enabled); err != nil {
			return nil, fmt.Errorf("list device profiles: %w", err)
		}
		result = append(result, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list device profiles: %w", err)
	}
	return result, nil
}

// SetDeviceProfiles replaces the device's whole enabled set in one
// transaction, so a profile dropped from the input is gone the moment this
// commits. Ids with no matching profile row are skipped rather than stored as
// dangling bindings.
func (s *Store) SetDeviceProfiles(ctx context.Context, input store.SetDeviceProfilesInput) error {
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		return errors.New("device id is required")
	}
	now := formatTime(time.Now())
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_profiles WHERE device_id = ?`, deviceID); err != nil {
			return fmt.Errorf("replace device %s profiles: %w", deviceID, err)
		}
		for _, profileID := range input.ProfileIDs {
			profileID = strings.TrimSpace(profileID)
			if profileID == "" {
				continue
			}
			_, err := tx.conn().ExecContext(ctx, `
				INSERT INTO device_profiles (device_id, profile_id, enabled, updated_at)
				SELECT ?, id, 1, ? FROM profiles WHERE id = ?
				ON CONFLICT(device_id, profile_id) DO UPDATE SET
					enabled = 1,
					updated_at = excluded.updated_at`,
				deviceID, now, profileID)
			if err != nil {
				return fmt.Errorf("enable profile %s for device %s: %w", profileID, deviceID, err)
			}
		}
		return nil
	})
}

// encodeModelList stores the list as JSON so a model name may contain any
// character a provider allows.
func encodeModelList(models []string) string {
	cleaned := make([]string, 0, len(models))
	seen := map[string]bool{}
	for _, model := range models {
		trimmed := strings.TrimSpace(model)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		cleaned = append(cleaned, trimmed)
	}
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

func decodeModelList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var models []string
	if err := json.Unmarshal([]byte(raw), &models); err != nil {
		return nil
	}
	return models
}

func scanProfile(row interface{ Scan(dest ...any) error }) (store.ProfileDefinition, error) {
	var profile store.ProfileDefinition
	var models string
	err := row.Scan(
		&profile.ID,
		&profile.Runtime,
		&profile.Label,
		&profile.AuthMode,
		&profile.ConnectionType,
		&profile.BaseURL,
		&profile.Model,
		&models,
		&profile.PromptPrefix,
		&profile.ClaudeEffort,
		&profile.ClaudePermissionMode,
		&profile.CodexReasoningEffort,
		&profile.CodexSandboxMode,
		&profile.CodexApprovalPolicy,
		&profile.CodexSpeed,
		&profile.OwnerUserID,
		&profile.UpdatedAtLabel,
	)
	if err != nil {
		return store.ProfileDefinition{}, err
	}
	profile.Models = decodeModelList(models)
	return profile, nil
}
