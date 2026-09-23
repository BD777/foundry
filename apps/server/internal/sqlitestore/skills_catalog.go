package sqlitestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// MaxSkillPackageBytes caps one promoted skill zip (64 MiB compressed). The worker
// enforces the same bound before upload.
const MaxSkillPackageBytes int64 = 64 << 20

// DefaultSkillRoots are the roots every device scans until it customizes its
// list. They stay tilde-relative because only the device knows its home dir.
var DefaultSkillRoots = []string{"~/.claude/skills", "~/.codex/skills"}

var skillSlugPattern = regexp.MustCompile(`[^a-z0-9-]+`)

func (s *Store) setupSkillCatalog(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS device_skill_roots (
			device_id TEXT NOT NULL,
			path TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, path)
		)`,
		`CREATE TABLE IF NOT EXISTS device_skills (
			device_id TEXT NOT NULL,
			root TEXT NOT NULL,
			dir_name TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			mtime_label TEXT NOT NULL DEFAULT '',
			dependencies TEXT NOT NULL DEFAULT '[]',
 dependency_analysis_error TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, root, dir_name)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_device_skills_device ON device_skills (device_id)`,
		`CREATE TABLE IF NOT EXISTS promoted_skills (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			origin_device_id TEXT NOT NULL,
			origin_root TEXT NOT NULL,
			origin_dir_name TEXT NOT NULL,
			latest_revision INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_promoted_skills_origin
			ON promoted_skills (origin_device_id, origin_root, origin_dir_name)`,
		`CREATE TABLE IF NOT EXISTS promoted_skill_revisions (
			skill_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			content BLOB NOT NULL,
			checksum TEXT NOT NULL,
			byte_size INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (skill_id, revision)
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_skill_bindings (
			workspace_id TEXT NOT NULL,
			skill_id TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (workspace_id, skill_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_skill_bindings_skill
			ON workspace_skill_bindings (skill_id)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite skill catalog: %w", err)
		}
	}
	if err := s.ensureColumn(ctx, "device_skills", "dependencies",
		`ALTER TABLE device_skills ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "device_skills", "dependency_analysis_error", `ALTER TABLE device_skills ADD COLUMN dependency_analysis_error TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "device_skills", "dependencies_analyzed", `ALTER TABLE device_skills ADD COLUMN dependencies_analyzed INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "device_skills", "source_digest", `ALTER TABLE device_skills ADD COLUMN source_digest TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	return s.setupSkillVersions(ctx)
}

// ListDeviceSkillRoots returns the customized roots for one device (or every
// device when deviceID is empty). Default roots are merged by the HTTP layer.
func (s *Store) ListDeviceSkillRoots(ctx context.Context, deviceID string) ([]store.DeviceSkillRoot, error) {
	query := `SELECT device_id, path FROM device_skill_roots ORDER BY device_id, path`
	args := []any{}
	if deviceID = strings.TrimSpace(deviceID); deviceID != "" {
		query = `SELECT device_id, path FROM device_skill_roots WHERE device_id = ? ORDER BY path`
		args = append(args, deviceID)
	}
	rows, err := s.conn().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list device skill roots: %w", err)
	}
	defer rows.Close()
	result := []store.DeviceSkillRoot{}
	for rows.Next() {
		var root store.DeviceSkillRoot
		if err := rows.Scan(&root.DeviceID, &root.Path); err != nil {
			return nil, fmt.Errorf("scan device skill root: %w", err)
		}
		result = append(result, root)
	}
	return result, rows.Err()
}

// SetDeviceSkillRoots replaces one device's custom root list. Default roots
// are not stored: an empty list restores the built-in defaults.
func (s *Store) SetDeviceSkillRoots(ctx context.Context, input store.SetDeviceSkillRootsInput) error {
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		return errors.New("device id is required")
	}
	now := formatTime(time.Now())
	paths := dedupeTrimmed(input.Paths)
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_skill_roots WHERE device_id = ?`, deviceID); err != nil {
			return fmt.Errorf("replace device %s skill roots: %w", deviceID, err)
		}
		for _, path := range paths {
			if _, err := tx.conn().ExecContext(ctx, `
				INSERT INTO device_skill_roots (device_id, path, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(device_id, path) DO UPDATE SET updated_at = excluded.updated_at`,
				deviceID, path, now); err != nil {
				return fmt.Errorf("save skill root %s for device %s: %w", path, deviceID, err)
			}
		}
		return nil
	})
}

// ReplaceDeviceSkills stores one scan snapshot, replacing the device's prior
// snapshot wholesale so removed directories disappear immediately.
func (s *Store) ReplaceDeviceSkills(ctx context.Context, input store.ReplaceDeviceSkillsInput) error {
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		return errors.New("device id is required")
	}
	now := formatTime(time.Now())
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM device_skills WHERE device_id = ?`, deviceID); err != nil {
			return fmt.Errorf("replace device %s skills: %w", deviceID, err)
		}
		seen := map[string]bool{}
		for _, item := range input.Skills {
			root := strings.TrimSpace(item.Root)
			dirName := strings.TrimSpace(item.DirName)
			if root == "" || dirName == "" {
				continue
			}
			key := root + "\x00" + dirName
			if seen[key] {
				continue
			}
			seen[key] = true
			name := strings.TrimSpace(item.Name)
			if name == "" {
				name = dirName
			}
			manifestJSON, _ := json.Marshal(item.Manifest)
			dependenciesJSON, err := json.Marshal(item.Dependencies)
			if err != nil {
				return fmt.Errorf("encode skill dependencies for %s/%s: %w", root, dirName, err)
			}
			if _, err := tx.conn().ExecContext(ctx, `
				INSERT INTO device_skills
					(device_id, root, dir_name, name, description, size_bytes, mtime_label, dependencies, dependency_analysis_error, dependencies_analyzed, source_digest, manifest_json, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				deviceID, root, dirName, name, strings.TrimSpace(item.Description),
				item.SizeBytes, strings.TrimSpace(item.MtimeLabel), string(dependenciesJSON), item.DependencyAnalysisError, item.DependenciesAnalyzed, item.SourceDigest, string(manifestJSON), now); err != nil {
				return fmt.Errorf("save scanned skill %s/%s: %w", root, dirName, err)
			}
		}
		return nil
	})
}

// ListDeviceSkills returns scan snapshots for one device, or every device
// when deviceID is empty, with the matching catalog id filled in.
func (s *Store) ListDeviceSkills(ctx context.Context, deviceID string) ([]store.DeviceSkill, error) {
	query := `
		SELECT ds.device_id, ds.root, ds.dir_name, ds.name, ds.description, ds.size_bytes, ds.mtime_label, ds.dependencies, ds.dependency_analysis_error, ds.dependencies_analyzed, ds.source_digest,
			(SELECT ss.skill_id FROM skill_sources ss
                WHERE ss.device_id=ds.device_id AND ss.root=ds.root AND ss.dir_name=ds.dir_name LIMIT 1)
		FROM device_skills ds`
	args := []any{}
	if deviceID = strings.TrimSpace(deviceID); deviceID != "" {
		query += ` WHERE ds.device_id = ?`
		args = append(args, deviceID)
	}
	query += ` ORDER BY ds.device_id, ds.root, ds.name`
	rows, err := s.conn().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list device skills: %w", err)
	}
	defer rows.Close()
	result := []store.DeviceSkill{}
	for rows.Next() {
		var item store.DeviceSkill
		var promoted sql.NullString
		var dependenciesJSON string
		if err := rows.Scan(&item.DeviceID, &item.Root, &item.DirName, &item.Name,
			&item.Description, &item.SizeBytes, &item.MtimeLabel, &dependenciesJSON, &item.DependencyAnalysisError, &item.DependenciesAnalyzed, &item.SourceDigest, &promoted); err != nil {
			return nil, fmt.Errorf("scan device skill: %w", err)
		}
		item.PromotedSkillID = promoted.String
		if strings.TrimSpace(dependenciesJSON) != "" {
			if err := json.Unmarshal([]byte(dependenciesJSON), &item.Dependencies); err != nil {
				return nil, fmt.Errorf("decode skill dependencies: %w", err)
			}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := s.enrichSkillStates(ctx, result); err != nil {
		return nil, err
	}
	return result, nil
}

// ListPromotedSkills returns the whole server catalog with origin device
// labels joined live, so a renamed or removed device never shows a stale name.
func (s *Store) ListPromotedSkills(ctx context.Context) ([]store.PromotedSkill, error) {
	rows, err := s.conn().QueryContext(ctx, `
		SELECT ps.id, ps.name, ps.description, ps.origin_device_id,
			COALESCE(d.label, ''), ps.origin_root, ps.origin_dir_name,
			ps.latest_revision, ps.created_at, ps.updated_at,
   COALESCE((SELECT source_digest FROM skill_revision_index WHERE skill_id=ps.id AND revision=ps.latest_revision),''),
   (SELECT json_group_array(w.name) FROM workspace_skill_bindings b JOIN workspaces w ON w.id=b.workspace_id WHERE b.skill_id=ps.id),
   COALESCE((SELECT ds.dependencies FROM device_skills ds WHERE ds.device_id=ps.origin_device_id AND ds.root=ps.origin_root AND ds.dir_name=ps.origin_dir_name LIMIT 1), '[]'),
   COALESCE((SELECT ds.dependency_analysis_error FROM device_skills ds WHERE ds.device_id=ps.origin_device_id AND ds.root=ps.origin_root AND ds.dir_name=ps.origin_dir_name LIMIT 1), '')
		FROM promoted_skills ps
		LEFT JOIN devices d ON d.id = ps.origin_device_id
		ORDER BY ps.name, ps.id`)
	if err != nil {
		return nil, fmt.Errorf("list promoted skills: %w", err)
	}
	defer rows.Close()
	result := []store.PromotedSkill{}
	for rows.Next() {
		skill, err := scanPromotedSkill(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, skill)
	}
	return result, rows.Err()
}

// GetPromotedSkill loads one catalog entry.
func (s *Store) GetPromotedSkill(ctx context.Context, id string) (store.PromotedSkill, error) {
	row := s.conn().QueryRowContext(ctx, `
		SELECT ps.id, ps.name, ps.description, ps.origin_device_id,
			COALESCE(d.label, ''), ps.origin_root, ps.origin_dir_name,
			ps.latest_revision, ps.created_at, ps.updated_at,
   COALESCE((SELECT source_digest FROM skill_revision_index WHERE skill_id=ps.id AND revision=ps.latest_revision),''),
   (SELECT json_group_array(w.name) FROM workspace_skill_bindings b JOIN workspaces w ON w.id=b.workspace_id WHERE b.skill_id=ps.id),
   COALESCE((SELECT ds.dependencies FROM device_skills ds WHERE ds.device_id=ps.origin_device_id AND ds.root=ps.origin_root AND ds.dir_name=ps.origin_dir_name LIMIT 1), '[]'),
   COALESCE((SELECT ds.dependency_analysis_error FROM device_skills ds WHERE ds.device_id=ps.origin_device_id AND ds.root=ps.origin_root AND ds.dir_name=ps.origin_dir_name LIMIT 1), '')
		FROM promoted_skills ps
		LEFT JOIN devices d ON d.id = ps.origin_device_id
		WHERE ps.id = ?`, id)
	skill, err := scanPromotedSkill(row)
	if errors.Is(err, sql.ErrNoRows) {
		return store.PromotedSkill{}, fmt.Errorf("%w: %s", store.ErrSkillNotFound, id)
	}
	return skill, err
}

// AddPromotedSkillRevision stores uploaded content. Re-promoting the same
// source (device/root/dir) adds a revision to the existing entry; byte-
// identical content to the latest revision is a no-op. Returns the entry and
// whether a new revision was created.
func (s *Store) AddPromotedSkillRevision(ctx context.Context, input store.PromoteSkillInput, name string, description string, content []byte, fileCount int) (store.PromotedSkill, bool, error) {
	idx, indexErr := skillarchive.Inspect(content)
	var result store.PromotedSkill
	var created bool
	err := s.withTx(ctx, func(tx *Store) error {
		var err error
		result, created, err = tx.addPromotedSkillRevision(ctx, input, name, description, content, fileCount, idx, indexErr)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO skill_sources(device_id,root,dir_name,skill_id,source_digest,content_digest) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,root,dir_name) DO UPDATE SET skill_id=excluded.skill_id,source_digest=excluded.source_digest,content_digest=excluded.content_digest`, input.DeviceID, input.Root, input.DirName, result.ID, idx.SourceDigest, result.SourceDigest)
		return err
	})
	return result, created, err
}
func (s *Store) addPromotedSkillRevision(ctx context.Context, input store.PromoteSkillInput, name string, description string, content []byte, fileCount int, idx skillarchive.Index, indexErr error) (store.PromotedSkill, bool, error) {
	deviceID := strings.TrimSpace(input.DeviceID)
	root := strings.TrimSpace(input.Root)
	dirName := strings.TrimSpace(input.DirName)
	if deviceID == "" || root == "" || dirName == "" {
		return store.PromotedSkill{}, false, errors.New("deviceId, root and dirName are required")
	}
	if int64(len(content)) > MaxSkillPackageBytes {
		return store.PromotedSkill{}, false, fmt.Errorf("%w: %d bytes", store.ErrSkillPackageTooLarge, len(content))
	}
	checksumBytes := sha256.Sum256(content)
	checksum := hex.EncodeToString(checksumBytes[:])
	var result store.PromotedSkill
	createdRevision := false
	err := s.withTx(ctx, func(tx *Store) error {
		now := formatTime(time.Now())
		var existingID, createdAt string
		var latestRevision int
		var latestChecksum, latestSourceDigest sql.NullString
		query := `SELECT id,latest_revision,created_at,
          (SELECT checksum FROM promoted_skill_revisions WHERE skill_id=promoted_skills.id AND revision=promoted_skills.latest_revision),
          (SELECT source_digest FROM skill_revision_index WHERE skill_id=promoted_skills.id AND revision=promoted_skills.latest_revision)
          FROM promoted_skills WHERE origin_device_id=? AND origin_root=? AND origin_dir_name=?`
		args := []any{deviceID, root, dirName}
		if input.TargetSkillID != "" {
			query = `SELECT id,latest_revision,created_at,
          (SELECT checksum FROM promoted_skill_revisions WHERE skill_id=promoted_skills.id AND revision=promoted_skills.latest_revision),
          (SELECT source_digest FROM skill_revision_index WHERE skill_id=promoted_skills.id AND revision=promoted_skills.latest_revision)
          FROM promoted_skills WHERE id=?`
			args = []any{input.TargetSkillID}
		}
		err := sql.ErrNoRows
		if !input.ForceNew {
			err = tx.conn().QueryRowContext(ctx, query, args...).Scan(&existingID, &latestRevision, &createdAt, &latestChecksum, &latestSourceDigest)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("look up promoted skill: %w", err)
		}
		if errors.Is(err, sql.ErrNoRows) {
			id, err := tx.mintSkillID(ctx, name)
			if err != nil {
				return err
			}
			existingID = id
			createdAt = now
		}
		if (latestChecksum.Valid && latestChecksum.String == checksum) || (idx.SourceDigest != "" && idx.SourceDigest == latestSourceDigest.String) {
			loaded, err := tx.GetPromotedSkill(ctx, existingID)
			if err != nil {
				return err
			}
			result = loaded
			return nil
		}
		revision := latestRevision + 1
		if _, err := tx.conn().ExecContext(ctx, `
			INSERT INTO promoted_skill_revisions
				(skill_id, revision, content, checksum, byte_size, file_count, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			existingID, revision, content, checksum, int64(len(content)), fileCount, now); err != nil {
			return fmt.Errorf("store skill revision: %w", err)
		}
		if latestRevision == 0 {
			if _, err := tx.conn().ExecContext(ctx, `
				INSERT INTO promoted_skills
					(id, name, description, origin_device_id, origin_root, origin_dir_name,
					latest_revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				existingID, name, description, deviceID, root, dirName, createdAt, now); err != nil {
				return fmt.Errorf("create promoted skill: %w", err)
			}
		} else {
			if _, err := tx.conn().ExecContext(ctx, `
				UPDATE promoted_skills
				SET name = ?, description = ?, latest_revision = ?, updated_at = ?
				WHERE id = ?`,
				name, description, revision, now, existingID); err != nil {
				return fmt.Errorf("update promoted skill: %w", err)
			}
		}
		if err := tx.saveSkillIndex(ctx, existingID, revision, idx, indexErr); err != nil {
			return err
		}
		createdRevision = true
		loaded, err := tx.GetPromotedSkill(ctx, existingID)
		if err != nil {
			return err
		}
		result = loaded
		return nil
	})
	return result, createdRevision, err
}

// mintSkillID turns the skill name into a slug; a slug already taken by a
// different source gets a random id instead of overwriting someone's entry.
func (s *Store) mintSkillID(ctx context.Context, name string) (string, error) {
	slug := "skill-" + skillSlugPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	slug = strings.Trim(slug, "-")
	if slug == "skill-" {
		slug = "skill-" + uuid.NewString()
	}
	var existingOrigin string
	err := s.conn().QueryRowContext(ctx,
		`SELECT origin_device_id || '|' || origin_root || '|' || origin_dir_name FROM promoted_skills WHERE id = ?`, slug).Scan(&existingOrigin)
	if errors.Is(err, sql.ErrNoRows) {
		return slug, nil
	}
	if err != nil {
		return "", fmt.Errorf("check skill id collision: %w", err)
	}
	return "skill-" + uuid.NewString(), nil
}

// GetSkillPackage fetches one revision's zip. Revision 0 means latest.
func (s *Store) GetSkillPackage(ctx context.Context, skillID string, revision int) (store.SkillPackage, error) {
	skillID = strings.TrimSpace(skillID)
	if skillID == "" {
		return store.SkillPackage{}, errors.New("skill id is required")
	}
	query := `SELECT r.skill_id, r.revision, r.content, r.checksum, r.byte_size, r.file_count
		FROM promoted_skill_revisions r
		WHERE r.skill_id = ? AND r.revision = ?`
	if revision <= 0 {
		query = `SELECT r.skill_id, r.revision, r.content, r.checksum, r.byte_size, r.file_count
			FROM promoted_skill_revisions r
			WHERE r.skill_id = ? AND r.revision = (SELECT latest_revision FROM promoted_skills WHERE id = ?)`
	}
	row := s.conn().QueryRowContext(ctx, query, appendSkillArgs(skillID, revision)...)
	var pkg store.SkillPackage
	err := row.Scan(&pkg.SkillID, &pkg.Revision, &pkg.Content, &pkg.Checksum, &pkg.ByteSize, &pkg.FileCount)
	if errors.Is(err, sql.ErrNoRows) {
		return store.SkillPackage{}, fmt.Errorf("%w: %s", store.ErrSkillPackageNotFound, skillID)
	}
	return pkg, err
}

func appendSkillArgs(skillID string, revision int) []any {
	if revision <= 0 {
		return []any{skillID, skillID}
	}
	return []any{skillID, revision}
}

// DeletePromotedSkill removes the entry, every revision and every binding.
func (s *Store) DeletePromotedSkill(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `DELETE FROM promoted_skills WHERE id = ?`, id)
		if err != nil {
			return fmt.Errorf("delete promoted skill %s: %w", id, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 0 {
			return fmt.Errorf("%w: %s", store.ErrSkillNotFound, id)
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM skill_sources WHERE skill_id=?`, id); err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM skill_revision_index WHERE skill_id=?`, id); err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM promoted_skill_revisions WHERE skill_id = ?`, id); err != nil {
			return fmt.Errorf("delete skill revisions %s: %w", id, err)
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM workspace_skill_bindings WHERE skill_id = ?`, id); err != nil {
			return fmt.Errorf("delete skill bindings %s: %w", id, err)
		}
		return nil
	})
}

// ListWorkspaceSkillBindings lists bindings for one workspace, or all.
func (s *Store) ListWorkspaceSkillBindings(ctx context.Context, workspaceID string) ([]store.WorkspaceSkillBinding, error) {
	query := `SELECT workspace_id, skill_id FROM workspace_skill_bindings ORDER BY workspace_id, skill_id`
	args := []any{}
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		query = `SELECT workspace_id, skill_id FROM workspace_skill_bindings WHERE workspace_id = ? ORDER BY skill_id`
		args = append(args, workspaceID)
	}
	rows, err := s.conn().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list workspace skill bindings: %w", err)
	}
	defer rows.Close()
	result := []store.WorkspaceSkillBinding{}
	for rows.Next() {
		var binding store.WorkspaceSkillBinding
		if err := rows.Scan(&binding.WorkspaceID, &binding.SkillID); err != nil {
			return nil, fmt.Errorf("scan workspace skill binding: %w", err)
		}
		result = append(result, binding)
	}
	return result, rows.Err()
}

// SetWorkspaceSkills replaces the workspace's whole selection; ids without a
// matching catalog row are skipped rather than stored as dangling bindings.
func (s *Store) SetWorkspaceSkills(ctx context.Context, input store.SetWorkspaceSkillsInput) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	now := formatTime(time.Now())
	skillIDs := dedupeTrimmed(input.SkillIDs)
	return s.withTx(ctx, func(tx *Store) error {
		names := map[string]bool{}
		for _, id := range skillIDs {
			item, err := tx.GetPromotedSkill(ctx, id)
			if errors.Is(err, store.ErrSkillNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if names[strings.ToLower(item.Name)] {
				return fmt.Errorf("workspace cannot enable two skills named %s; choose one version or rename the fork", item.Name)
			}
			names[strings.ToLower(item.Name)] = true
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM workspace_skill_bindings WHERE workspace_id = ?`, workspaceID); err != nil {
			return fmt.Errorf("replace workspace %s skills: %w", workspaceID, err)
		}
		for _, skillID := range skillIDs {
			if _, err := tx.conn().ExecContext(ctx, `
				INSERT INTO workspace_skill_bindings (workspace_id, skill_id, updated_at)
				SELECT ?, id, ? FROM promoted_skills WHERE id = ?`,
				workspaceID, now, skillID); err != nil {
				return fmt.Errorf("bind skill %s to workspace %s: %w", skillID, workspaceID, err)
			}
		}
		return nil
	})
}

// ResolveSessionSkills expands a workspace's selection to the current latest
// revisions. An empty slice means the runtime must expose no skills.
func (s *Store) ResolveSessionSkills(ctx context.Context, workspaceID string) ([]store.SessionSkillRef, error) {
	rows, err := s.conn().QueryContext(ctx, `
		SELECT ps.id, ps.latest_revision, ps.name, r.checksum, r.byte_size
		FROM workspace_skill_bindings b
		JOIN promoted_skills ps ON ps.id = b.skill_id
		JOIN promoted_skill_revisions r ON r.skill_id = ps.id AND r.revision = ps.latest_revision
		WHERE b.workspace_id = ?
		ORDER BY ps.name`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("resolve session skills: %w", err)
	}
	defer rows.Close()
	result := []store.SessionSkillRef{}
	for rows.Next() {
		var ref store.SessionSkillRef
		if err := rows.Scan(&ref.SkillID, &ref.Revision, &ref.Name, &ref.Checksum, &ref.ByteSize); err != nil {
			return nil, fmt.Errorf("scan session skill ref: %w", err)
		}
		result = append(result, ref)
	}
	return result, rows.Err()
}

// AttachSessionSkills stamps the resolved selection onto the session payload
// so dispatch, resume and audit all agree on what the run was allowed to use.
func (s *Store) AttachSessionSkills(ctx context.Context, sessionID string, refs []store.SessionSkillRef) error {
	session, err := s.GetAgentSession(ctx, sessionID)
	if err != nil {
		return err
	}
	session.SkillRefs = refs
	return s.saveAgentSession(ctx, session, time.Time{}, time.Now().UTC())
}

func scanPromotedSkill(row interface{ Scan(dest ...any) error }) (store.PromotedSkill, error) {
	var skill store.PromotedSkill
	var workspaces string
	var dependenciesJSON string
	err := row.Scan(
		&skill.ID, &skill.Name, &skill.Description, &skill.OriginDeviceID,
		&skill.OriginDeviceLabel, &skill.OriginRoot, &skill.OriginDirName,
		&skill.LatestRevision, &skill.CreatedLabel, &skill.UpdatedLabel, &skill.SourceDigest, &workspaces,
		&dependenciesJSON, &skill.DependencyAnalysisError,
	)
	if err != nil {
		return store.PromotedSkill{}, err
	}
	if err := json.Unmarshal([]byte(workspaces), &skill.UsedByWorkspaces); err != nil {
		return store.PromotedSkill{}, err
	}
	if strings.TrimSpace(dependenciesJSON) != "" && dependenciesJSON != "null" {
		_ = json.Unmarshal([]byte(dependenciesJSON), &skill.Dependencies)
	}
	return skill, nil
}

func dedupeTrimmed(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	return result
}
