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

func (s *Store) setupWorkerGroups(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS worker_groups (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			label TEXT NOT NULL,
			members_json TEXT NOT NULL,
			cursor INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_worker_groups_owner ON worker_groups (owner_user_id, label)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite worker groups: %w", err)
		}
	}
	return s.migrateModelPools(ctx)
}

// migrateModelPools turns each equivalent-model pool, which belonged to one
// provider and runtime, into a worker group whose members carry that provider
// and runtime themselves, then drops the old table. It runs once: the table
// is gone afterwards.
func (s *Store) migrateModelPools(ctx context.Context) error {
	var present int
	if err := s.conn().QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'model_pools'`).Scan(&present); err != nil {
		return fmt.Errorf("migrate sqlite model pools: %w", err)
	}
	if present == 0 {
		return nil
	}
	err := s.withTx(ctx, func(tx *Store) error {
		rows, err := tx.conn().QueryContext(ctx, `SELECT id, owner_user_id, provider_kind, provider_id, runtime, label,
			members_json, cursor, created_at, updated_at FROM model_pools`)
		if err != nil {
			return err
		}
		type legacyPool struct {
			id, owner, kind, provider, runtime, label, members, created, updated string
			cursor                                                               int
		}
		var pools []legacyPool
		for rows.Next() {
			var pool legacyPool
			if err := rows.Scan(&pool.id, &pool.owner, &pool.kind, &pool.provider, &pool.runtime, &pool.label,
				&pool.members, &pool.cursor, &pool.created, &pool.updated); err != nil {
				rows.Close()
				return err
			}
			pools = append(pools, pool)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, pool := range pools {
			var members []map[string]any
			if err := json.Unmarshal([]byte(pool.members), &members); err != nil {
				return fmt.Errorf("decode model pool %s: %w", pool.id, err)
			}
			for _, member := range members {
				member["providerKind"], member["providerId"], member["runtime"] = pool.kind, pool.provider, pool.runtime
			}
			encoded, err := json.Marshal(members)
			if err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT OR IGNORE INTO worker_groups
				(id, owner_user_id, label, members_json, cursor, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				pool.id, pool.owner, pool.label, string(encoded), pool.cursor, pool.created, pool.updated); err != nil {
				return err
			}
		}
		_, err = tx.conn().ExecContext(ctx, `DROP TABLE model_pools`)
		return err
	})
	if err != nil {
		return fmt.Errorf("migrate sqlite model pools: %w", err)
	}
	return nil
}

const workerGroupColumns = `id, owner_user_id, label, members_json, cursor, created_at, updated_at`

func providerKindValid(kind string) bool {
	return kind == "subscription" || kind == "api" || kind == "environment" || kind == "discovered"
}

func normalizeWorkerGroup(group *store.StoredWorkerGroup) error {
	group.ID = strings.TrimSpace(group.ID)
	group.OwnerUserID = strings.TrimSpace(group.OwnerUserID)
	group.Label = strings.TrimSpace(group.Label)
	switch {
	case group.OwnerUserID == "":
		return errors.New("worker group owner is required")
	case group.Label == "":
		return errors.New("worker group label is required")
	case len(group.Members) == 0:
		return errors.New("worker group needs at least one member")
	}
	seen := map[string]bool{}
	for index := range group.Members {
		member := &group.Members[index]
		member.ProviderID = strings.TrimSpace(member.ProviderID)
		member.Model = strings.TrimSpace(member.Model)
		member.Effort = strings.TrimSpace(member.Effort)
		runtime := string(member.Runtime)
		switch {
		case !providerKindValid(string(member.ProviderKind)):
			return errors.New("worker group member provider kind is invalid")
		case member.ProviderID == "":
			return errors.New("worker group member provider is required")
		case runtime != "claude" && runtime != "codex":
			return errors.New("worker group member runtime must be claude or codex")
		case member.Model == "":
			return errors.New("worker group member model is required")
		case member.TokensPerMinute < 0:
			return fmt.Errorf("worker group member %s needs a non-negative tokensPerMinute", member.Model)
		case member.Weight < 0:
			return fmt.Errorf("worker group member %s needs a non-negative weight", member.Model)
		}
		key := string(member.ProviderKind) + "\x00" + member.ProviderID + "\x00" + runtime + "\x00" + member.Model
		if seen[key] {
			return fmt.Errorf("worker group member %s on %s is repeated", member.Model, member.ProviderID)
		}
		seen[key] = true
		if member.Weight == 0 {
			member.Weight = 1
		}
	}
	return nil
}

func scanWorkerGroup(row interface{ Scan(...any) error }) (store.StoredWorkerGroup, error) {
	var group store.StoredWorkerGroup
	var members string
	err := row.Scan(&group.ID, &group.OwnerUserID, &group.Label, &members, &group.Cursor, &group.CreatedAt, &group.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoredWorkerGroup{}, store.ErrWorkerGroupNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(members), &group.Members)
	}
	return group, err
}

func (s *Store) ListWorkerGroups(ctx context.Context, ownerUserID string) ([]store.StoredWorkerGroup, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+workerGroupColumns+`
		FROM worker_groups WHERE owner_user_id = ? ORDER BY lower(label), id`, strings.TrimSpace(ownerUserID))
	if err != nil {
		return nil, fmt.Errorf("list worker groups: %w", err)
	}
	defer rows.Close()
	groups := []store.StoredWorkerGroup{}
	for rows.Next() {
		group, err := scanWorkerGroup(rows)
		if err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

func (s *Store) GetWorkerGroup(ctx context.Context, id string) (store.StoredWorkerGroup, error) {
	group, err := scanWorkerGroup(s.reader().QueryRowContext(ctx, `SELECT `+workerGroupColumns+`
		FROM worker_groups WHERE id = ?`, strings.TrimSpace(id)))
	if err != nil && !errors.Is(err, store.ErrWorkerGroupNotFound) {
		return store.StoredWorkerGroup{}, fmt.Errorf("get worker group: %w", err)
	}
	return group, err
}

func (s *Store) SaveWorkerGroup(ctx context.Context, group store.StoredWorkerGroup) (store.StoredWorkerGroup, error) {
	if err := normalizeWorkerGroup(&group); err != nil {
		return store.StoredWorkerGroup{}, err
	}
	if group.ID == "" {
		group.ID = "wgroup_" + uuid.NewString()
	}
	now := formatTime(time.Now().UTC())
	if group.CreatedAt == "" {
		group.CreatedAt = now
	}
	group.UpdatedAt = now
	members, err := json.Marshal(group.Members)
	if err != nil {
		return store.StoredWorkerGroup{}, err
	}
	result, err := s.conn().ExecContext(ctx, `INSERT INTO worker_groups
		(id, owner_user_id, label, members_json, cursor, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label = excluded.label,
			members_json = excluded.members_json,
			cursor = CASE WHEN worker_groups.members_json = excluded.members_json
				THEN worker_groups.cursor ELSE 0 END,
			updated_at = excluded.updated_at
		WHERE worker_groups.owner_user_id = excluded.owner_user_id`,
		group.ID, group.OwnerUserID, group.Label, string(members), max(group.Cursor, 0), group.CreatedAt, group.UpdatedAt)
	if err != nil {
		return store.StoredWorkerGroup{}, fmt.Errorf("save worker group: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.StoredWorkerGroup{}, store.ErrWorkerGroupNotFound
	}
	return s.GetWorkerGroup(ctx, group.ID)
}

func (s *Store) DeleteWorkerGroup(ctx context.Context, id, ownerUserID string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM worker_groups WHERE id = ? AND owner_user_id = ?`,
		strings.TrimSpace(id), strings.TrimSpace(ownerUserID))
	if err != nil {
		return fmt.Errorf("delete worker group: %w", err)
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return store.ErrWorkerGroupNotFound
	}
	return nil
}

func (s *Store) AdvanceWorkerGroupCursor(ctx context.Context, id string, memberCount int) (int, error) {
	if memberCount <= 0 {
		return 0, errors.New("worker group member count must be positive")
	}
	cursor := 0
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.conn().QueryRowContext(ctx, `SELECT cursor FROM worker_groups WHERE id = ?`,
			strings.TrimSpace(id)).Scan(&cursor); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return store.ErrWorkerGroupNotFound
			}
			return err
		}
		_, err := tx.conn().ExecContext(ctx, `UPDATE worker_groups SET cursor = ?
			WHERE id = ?`, (cursor+1)%memberCount, strings.TrimSpace(id))
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("advance worker group cursor: %w", err)
	}
	return cursor % memberCount, nil
}

func (s *Store) RecentModelTokens(ctx context.Context, since time.Time, ownerUserID, profileID, runtime string, models []string) (map[string]int64, error) {
	models = uniqueModelIDs(models)
	usage := map[string]int64{}
	if len(models) == 0 {
		return usage, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(models)), ",")
	args := make([]any, 0, len(models)+5)
	args = append(args, formatTime(since), strings.TrimSpace(ownerUserID), strings.TrimSpace(profileID), strings.TrimSpace(runtime))
	for _, model := range models {
		args = append(args, model)
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT model,
			SUM(input_tokens + output_tokens)
		FROM usage_requests
		WHERE at >= ? AND user_id = ? AND profile_id = ? AND runtime = ? AND model IN (`+placeholders+`)
		GROUP BY model`, args...)
	if err != nil {
		return nil, fmt.Errorf("sum recent model request tokens: %w", err)
	}
	for rows.Next() {
		var model string
		var tokens int64
		if err := rows.Scan(&model, &tokens); err != nil {
			rows.Close()
			return nil, err
		}
		usage[model] = tokens
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	// A turn only supplies totals when its input has no request rows. This
	// keeps older worker reports useful without counting the same tokens twice.
	args = append([]any{formatTime(since), strings.TrimSpace(ownerUserID), strings.TrimSpace(profileID), strings.TrimSpace(runtime)}, args[4:]...)
	rows, err = s.reader().QueryContext(ctx, `SELECT turn.model,
			SUM(turn.input_tokens + turn.output_tokens + turn.reasoning_tokens)
		FROM usage_turns AS turn
		WHERE turn.ended_at >= ? AND turn.user_id = ? AND turn.profile_id = ? AND turn.runtime = ?
			AND turn.model IN (`+placeholders+`)
			AND NOT EXISTS (
				SELECT 1 FROM usage_requests AS request
				WHERE request.session_id = turn.session_id
					AND request.input_id = turn.input_id
			)
		GROUP BY turn.model`, args...)
	if err != nil {
		return nil, fmt.Errorf("sum recent model turn tokens: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var model string
		var tokens int64
		if err := rows.Scan(&model, &tokens); err != nil {
			return nil, err
		}
		usage[model] += tokens
	}
	return usage, rows.Err()
}

func uniqueModelIDs(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
