package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

func (s *Store) migrateSkillRepositories(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS skill_repositories (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			label TEXT NOT NULL,
			ref TEXT NOT NULL DEFAULT '',
			subpath TEXT NOT NULL DEFAULT '',
			commit_sha TEXT NOT NULL DEFAULT '',
			checked_at TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			UNIQUE (url, ref, subpath)
		)`,
		`CREATE TABLE IF NOT EXISTS skill_repository_skills (
			skill_id TEXT PRIMARY KEY,
			repository_id TEXT NOT NULL,
			dir TEXT NOT NULL,
			commit_sha TEXT NOT NULL,
			UNIQUE (repository_id, dir)
		)`,
		// Picked skills once waited here for review; they now follow new
		// versions like a bundle's, so held updates are superseded.
		`DROP TABLE IF EXISTS skill_repository_updates`,
		`CREATE TABLE IF NOT EXISTS skill_bundle_versions (
			repository_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			tag TEXT NOT NULL,
			commit_sha TEXT NOT NULL,
			applied_at TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			PRIMARY KEY (repository_id, seq)
		)`,
		`CREATE TABLE IF NOT EXISTS skill_bundle_selections (
			scope TEXT NOT NULL,
			owner_id TEXT NOT NULL,
			repository_id TEXT NOT NULL,
			PRIMARY KEY (scope, owner_id, repository_id)
		)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate skill repositories: %w", err)
		}
	}
	for _, column := range []struct{ table, name, ddl string }{
		{"skill_repositories", "mode", `ALTER TABLE skill_repositories ADD COLUMN mode TEXT NOT NULL DEFAULT 'pick'`},
		{"skill_repositories", "name", `ALTER TABLE skill_repositories ADD COLUMN name TEXT NOT NULL DEFAULT ''`},
		{"skill_repositories", "version", `ALTER TABLE skill_repositories ADD COLUMN version TEXT NOT NULL DEFAULT ''`},
		{"skill_repositories", "paused", `ALTER TABLE skill_repositories ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`},
		{"skill_repositories", "tools_json", `ALTER TABLE skill_repositories ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'`},
		{"skill_repository_skills", "retired", `ALTER TABLE skill_repository_skills ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`},
		{"skill_repositories", "found_count", `ALTER TABLE skill_repositories ADD COLUMN found_count INTEGER NOT NULL DEFAULT 0`},
		{"skill_repositories", "description", `ALTER TABLE skill_repositories ADD COLUMN description TEXT NOT NULL DEFAULT ''`},
		{"skill_repositories", "declared_tools_json", `ALTER TABLE skill_repositories ADD COLUMN declared_tools_json TEXT NOT NULL DEFAULT '[]'`},
		{"skill_repository_skills", "missing", `ALTER TABLE skill_repository_skills ADD COLUMN missing INTEGER NOT NULL DEFAULT 0`},
		{"skill_repositories", "fetch_device_id", `ALTER TABLE skill_repositories ADD COLUMN fetch_device_id TEXT NOT NULL DEFAULT ''`},
		{"skill_repositories", "registry", `ALTER TABLE skill_repositories ADD COLUMN registry TEXT NOT NULL DEFAULT ''`},
		{"skill_repositories", "check_waiting", `ALTER TABLE skill_repositories ADD COLUMN check_waiting INTEGER NOT NULL DEFAULT 0`},
	} {
		if err := s.ensureColumn(ctx, column.table, column.name, column.ddl); err != nil {
			return err
		}
	}
	return nil
}

// CreateSkillRepository records a repository; one URL, ref and folder is
// recorded once.
func (s *Store) CreateSkillRepository(ctx context.Context, repo store.SkillRepository, createdBy string) (store.SkillRepository, error) {
	repo.ID = "repo_" + uuid.NewString()
	repo.CreatedAt = formatTime(time.Now())
	if repo.Mode != "bundle" {
		repo.Mode = "pick"
	}
	if repo.DeclaredTools == nil {
		repo.DeclaredTools = []store.SkillToolDeclaration{}
	}
	declared, err := json.Marshal(repo.DeclaredTools)
	if err != nil {
		return store.SkillRepository{}, err
	}
	_, err = s.conn().ExecContext(ctx, `
		INSERT INTO skill_repositories (id, url, label, ref, subpath, commit_sha, checked_at, created_by, created_at, mode, name, declared_tools_json, fetch_device_id, registry)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		repo.ID, repo.URL, repo.Label, repo.Ref, repo.Subpath, repo.Commit, repo.CheckedAt, createdBy, repo.CreatedAt, repo.Mode, repo.Name, string(declared), repo.FetchDeviceID, repo.Registry)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return store.SkillRepository{}, fmt.Errorf("%s is already in the library", repo.Label)
	}
	if err != nil {
		return store.SkillRepository{}, err
	}
	repo.Skills = []store.SkillRepositorySkill{}
	return repo, nil
}

// ListSkillRepositories lists every repository with its skills and recent
// versions.
func (s *Store) ListSkillRepositories(ctx context.Context) ([]store.SkillRepository, error) {
	return s.querySkillRepositories(ctx, "")
}

// GetSkillRepository loads one repository.
func (s *Store) GetSkillRepository(ctx context.Context, id string) (store.SkillRepository, error) {
	repos, err := s.querySkillRepositories(ctx, id)
	if err != nil {
		return store.SkillRepository{}, err
	}
	if len(repos) == 0 {
		return store.SkillRepository{}, store.ErrNotFound
	}
	return repos[0], nil
}

func (s *Store) querySkillRepositories(ctx context.Context, id string) ([]store.SkillRepository, error) {
	query := `SELECT r.id, r.url, r.label, r.ref, r.subpath, r.commit_sha, r.checked_at, r.error, r.created_at, r.mode, r.name, r.version, r.paused,
		r.tools_json, r.found_count, r.description, r.declared_tools_json, r.fetch_device_id, COALESCE(d.label, ''), r.registry, r.check_waiting
		FROM skill_repositories r LEFT JOIN devices d ON d.id = r.fetch_device_id`
	args := []any{}
	if id != "" {
		query += ` WHERE r.id = ?`
		args = append(args, id)
	}
	rows, err := s.conn().QueryContext(ctx, query+` ORDER BY r.label, r.ref, r.subpath`, args...)
	if err != nil {
		return nil, fmt.Errorf("list skill repositories: %w", err)
	}
	repos := []store.SkillRepository{}
	index := map[string]int{}
	for rows.Next() {
		var repo store.SkillRepository
		var toolsJSON, declaredJSON string
		if err := rows.Scan(&repo.ID, &repo.URL, &repo.Label, &repo.Ref, &repo.Subpath, &repo.Commit, &repo.CheckedAt, &repo.Error, &repo.CreatedAt,
			&repo.Mode, &repo.Name, &repo.Version, &repo.Paused, &toolsJSON, &repo.FoundCount, &repo.Description, &declaredJSON,
			&repo.FetchDeviceID, &repo.FetchDeviceName, &repo.Registry, &repo.CheckWaiting); err != nil {
			rows.Close()
			return nil, err
		}
		_ = json.Unmarshal([]byte(toolsJSON), &repo.Tools)
		_ = json.Unmarshal([]byte(declaredJSON), &repo.DeclaredTools)
		repo.Skills = []store.SkillRepositorySkill{}
		index[repo.ID] = len(repos)
		repos = append(repos, repo)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadBundleVersions(ctx, repos, index); err != nil {
		return nil, err
	}
	skills, err := s.conn().QueryContext(ctx, `
		SELECT k.repository_id, k.skill_id, k.dir, k.commit_sha, COALESCE(p.name, ''), k.retired, k.missing
		FROM skill_repository_skills k
		LEFT JOIN promoted_skills p ON p.id = k.skill_id
		ORDER BY k.dir`)
	if err != nil {
		return nil, fmt.Errorf("list repository skills: %w", err)
	}
	defer skills.Close()
	for skills.Next() {
		var repoID string
		var skill store.SkillRepositorySkill
		if err := skills.Scan(&repoID, &skill.SkillID, &skill.Dir, &skill.Commit, &skill.Name, &skill.Retired, &skill.Missing); err != nil {
			return nil, err
		}
		if i, ok := index[repoID]; ok {
			repos[i].Skills = append(repos[i].Skills, skill)
		}
	}
	return repos, skills.Err()
}

// RecordSkillRepositoryCheck saves the outcome of asking the remote; a
// check that ran is no longer waiting for its device.
func (s *Store) RecordSkillRepositoryCheck(ctx context.Context, id, commit, checkErr string) error {
	query := `UPDATE skill_repositories SET checked_at = ?, error = ?, check_waiting = 0 WHERE id = ?`
	args := []any{formatTime(time.Now()), checkErr, id}
	if commit != "" {
		query = `UPDATE skill_repositories SET checked_at = ?, error = ?, check_waiting = 0, commit_sha = ? WHERE id = ?`
		args = []any{formatTime(time.Now()), checkErr, commit, id}
	}
	_, err := s.conn().ExecContext(ctx, query, args...)
	return err
}

// MarkSkillRepositoryWaiting records that a check could not run because
// the repository's fetch device was offline.
func (s *Store) MarkSkillRepositoryWaiting(ctx context.Context, id string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET check_waiting = 1 WHERE id = ?`, id)
	return err
}

// SetSkillRepositorySource changes where a repository is read: the server
// (deviceID "") or one device, and the npm registry it uses. The last
// check's outcome belonged to the old place, so it is cleared.
func (s *Store) SetSkillRepositorySource(ctx context.Context, id, deviceID, registry string) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET fetch_device_id = ?, registry = ?, check_waiting = 0, error = '' WHERE id = ?`, deviceID, registry, id)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

// RecordRepositoryDescription saves the repository's own description; an
// empty one (not published, or the host did not answer) keeps the last.
func (s *Store) RecordRepositoryDescription(ctx context.Context, id, description string) error {
	if strings.TrimSpace(description) == "" {
		return nil
	}
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET description = ? WHERE id = ?`, strings.TrimSpace(description), id)
	return err
}

// RecordRepositoryFolders saves how many skill folders the repository held
// when it was last read.
func (s *Store) RecordRepositoryFolders(ctx context.Context, id string, count int) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repositories SET found_count = ? WHERE id = ?`, count, id)
	return err
}

// LinkSkillRepositorySkill records that a library skill's latest revision
// came from a repository folder at a commit; the folder is there again.
func (s *Store) LinkSkillRepositorySkill(ctx context.Context, repositoryID, dir, skillID, commit string) error {
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO skill_repository_skills (skill_id, repository_id, dir, commit_sha, retired, missing) VALUES (?, ?, ?, ?, 0, 0)
		ON CONFLICT (skill_id) DO UPDATE SET repository_id = excluded.repository_id, dir = excluded.dir, commit_sha = excluded.commit_sha, retired = 0, missing = 0`,
		skillID, repositoryID, dir, commit)
	return err
}

// MarkRepositorySkillMissing flags a picked skill whose folder is gone from
// its repository; the library keeps it at its last revision.
func (s *Store) MarkRepositorySkillMissing(ctx context.Context, skillID string) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE skill_repository_skills SET missing = 1 WHERE skill_id = ?`, skillID)
	return err
}

// DeleteSkillRepository stops following a repository. Its skills stay in the
// library with the revisions they have.
func (s *Store) DeleteSkillRepository(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `DELETE FROM skill_repositories WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if changed, _ := result.RowsAffected(); changed == 0 {
			return store.ErrNotFound
		}
		for _, statement := range []string{
			`DELETE FROM skill_repository_skills WHERE repository_id = ?`,
			`DELETE FROM skill_bundle_versions WHERE repository_id = ?`,
			`DELETE FROM skill_bundle_selections WHERE repository_id = ?`,
		} {
			if _, err := tx.conn().ExecContext(ctx, statement, id); err != nil {
				return err
			}
		}
		return nil
	})
}
