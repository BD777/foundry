package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// bundleVersionsShown bounds the versions listed with a bundle.
const bundleVersionsShown = 10

func (s *Store) loadBundleVersions(ctx context.Context, repos []store.SkillRepository, index map[string]int) error {
	rows, err := s.conn().QueryContext(ctx, `
		SELECT repository_id, seq, tag, commit_sha, applied_at, payload_json FROM skill_bundle_versions
		ORDER BY repository_id, seq DESC`)
	if err != nil {
		return fmt.Errorf("list bundle versions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var repoID, payload string
		var version store.SkillBundleVersion
		if err := rows.Scan(&repoID, &version.Seq, &version.Tag, &version.Commit, &version.AppliedAt, &payload); err != nil {
			return err
		}
		_ = json.Unmarshal([]byte(payload), &version)
		if i, ok := index[repoID]; ok && len(repos[i].Versions) < bundleVersionsShown {
			repos[i].Versions = append(repos[i].Versions, version)
		}
	}
	return rows.Err()
}

// GetBundleVersion loads one recorded version of a bundle.
func (s *Store) GetBundleVersion(ctx context.Context, repositoryID string, seq int) (store.SkillBundleVersion, error) {
	var version store.SkillBundleVersion
	var payload string
	err := s.conn().QueryRowContext(ctx, `
		SELECT seq, tag, commit_sha, applied_at, payload_json FROM skill_bundle_versions WHERE repository_id = ? AND seq = ?`,
		repositoryID, seq).Scan(&version.Seq, &version.Tag, &version.Commit, &version.AppliedAt, &payload)
	if err != nil {
		return version, store.ErrNotFound
	}
	_ = json.Unmarshal([]byte(payload), &version)
	return version, nil
}

// RecordBundleVersion appends an applied version and makes it the bundle's
// current one.
func (s *Store) RecordBundleVersion(ctx context.Context, repositoryID string, version store.SkillBundleVersion, paused bool) (store.SkillBundleVersion, error) {
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.conn().QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) + 1 FROM skill_bundle_versions WHERE repository_id = ?`, repositoryID).Scan(&version.Seq); err != nil {
			return err
		}
		version.AppliedAt = formatTime(time.Now())
		payload, err := json.Marshal(version)
		if err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `
			INSERT INTO skill_bundle_versions (repository_id, seq, tag, commit_sha, applied_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
			repositoryID, version.Seq, version.Tag, version.Commit, version.AppliedAt, string(payload)); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `
			UPDATE skill_repositories SET version = ?, commit_sha = ?, paused = ?, checked_at = ?, error = '', check_waiting = 0 WHERE id = ?`,
			version.Tag, version.Commit, paused, version.AppliedAt, repositoryID)
		return err
	})
	return version, err
}

// SetSkillRepositoryMode switches how a repository is followed ("pick" or
// "bundle") and names it.
func (s *Store) SetSkillRepositoryMode(ctx context.Context, repositoryID, mode, name string) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET mode = ?, name = ? WHERE id = ?`, mode, name, repositoryID)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

// SetBundlePaused pauses or resumes a bundle's automatic updates.
func (s *Store) SetBundlePaused(ctx context.Context, repositoryID string, paused bool) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET paused = ? WHERE id = ?`, paused, repositoryID)
	return err
}

// SetBundleTools records the programs a bundle needs.
func (s *Store) SetBundleTools(ctx context.Context, repositoryID string, tools []store.SkillBundleTool) error {
	if tools == nil {
		tools = []store.SkillBundleTool{}
	}
	encoded, err := json.Marshal(tools)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE skill_repositories SET tools_json = ? WHERE id = ?`, string(encoded), repositoryID)
	return err
}

// RetireRepositorySkill takes a skill out of its bundle: sessions stop
// getting it; the library keeps it and its revisions.
func (s *Store) RetireRepositorySkill(ctx context.Context, skillID string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repository_skills SET retired = 1 WHERE skill_id = ?`, skillID)
	return err
}

// Bundle selections: "workspace" selections by workspace id, "user"
// defaults by user id, and "workspace-off": default bundles a workspace
// turned off.
const (
	BundleScopeWorkspace    = "workspace"
	BundleScopeUser         = "user"
	BundleScopeWorkspaceOff = "workspace-off"
)

// ListBundleSelection lists the bundles a workspace or person selected.
func (s *Store) ListBundleSelection(ctx context.Context, scope, ownerID string) ([]string, error) {
	rows, err := s.conn().QueryContext(ctx, `
		SELECT b.repository_id FROM skill_bundle_selections b JOIN skill_repositories r ON r.id = b.repository_id
		WHERE b.scope = ? AND b.owner_id = ? AND r.mode = 'bundle' ORDER BY r.name, r.label`, scope, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// SetBundleSelection replaces a workspace's or person's selected bundles;
// ids that are not bundles are skipped.
func (s *Store) SetBundleSelection(ctx context.Context, scope, ownerID string, repositoryIDs []string) error {
	ids := dedupeTrimmed(repositoryIDs)
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM skill_bundle_selections WHERE scope = ? AND owner_id = ?`, scope, ownerID); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := tx.conn().ExecContext(ctx, `
				INSERT INTO skill_bundle_selections (scope, owner_id, repository_id)
				SELECT ?, ?, id FROM skill_repositories WHERE id = ? AND mode = 'bundle'`, scope, ownerID, id); err != nil {
				return err
			}
		}
		return nil
	})
}

// ResolveBundleSkills expands bundles into their current skills at their
// latest revisions; retired skills are left out.
func (s *Store) ResolveBundleSkills(ctx context.Context, repositoryIDs []string) ([]store.SessionSkillRef, error) {
	if len(repositoryIDs) == 0 {
		return []store.SessionSkillRef{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(repositoryIDs)), ",")
	args := make([]any, 0, len(repositoryIDs))
	for _, id := range repositoryIDs {
		args = append(args, id)
	}
	rows, err := s.conn().QueryContext(ctx, `
		SELECT ps.id, ps.latest_revision, ps.name, r.checksum, r.byte_size
		FROM skill_repository_skills k
		JOIN skill_repositories repo ON repo.id = k.repository_id AND repo.mode = 'bundle'
		JOIN promoted_skills ps ON ps.id = k.skill_id
		JOIN promoted_skill_revisions r ON r.skill_id = ps.id AND r.revision = ps.latest_revision
		WHERE k.retired = 0 AND k.repository_id IN (`+placeholders+`)
		ORDER BY ps.name`, args...)
	if err != nil {
		return nil, fmt.Errorf("resolve bundle skills: %w", err)
	}
	defer rows.Close()
	refs := []store.SessionSkillRef{}
	for rows.Next() {
		var ref store.SessionSkillRef
		if err := rows.Scan(&ref.SkillID, &ref.Revision, &ref.Name, &ref.Checksum, &ref.ByteSize); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

// WorkspaceOwner is the person who owns a workspace's device.
func (s *Store) WorkspaceOwner(ctx context.Context, workspaceID string) (string, error) {
	var owner string
	err := s.conn().QueryRowContext(ctx, `
		SELECT di.owner_user_id FROM workspaces w
		JOIN device_identities di ON di.device_id = json_extract(w.payload_json, '$.deviceId') AND di.revoked_at IS NULL
		WHERE w.id = ?`, workspaceID).Scan(&owner)
	if err != nil {
		return "", nil
	}
	return owner, nil
}
