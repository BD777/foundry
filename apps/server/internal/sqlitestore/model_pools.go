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

func (s *Store) setupModelPools(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS model_pools (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			provider_kind TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			runtime TEXT NOT NULL,
			label TEXT NOT NULL,
			members_json TEXT NOT NULL,
			cursor INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_model_pools_owner
			ON model_pools (owner_user_id, provider_kind, provider_id, runtime, label)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite model pools: %w", err)
		}
	}
	return nil
}

const modelPoolColumns = `id, owner_user_id, provider_kind, provider_id, runtime, label,
	members_json, cursor, created_at, updated_at`

func normalizeModelPool(pool *store.StoredModelPool) error {
	pool.ID = strings.TrimSpace(pool.ID)
	pool.OwnerUserID = strings.TrimSpace(pool.OwnerUserID)
	pool.ProviderKind = strings.TrimSpace(pool.ProviderKind)
	pool.ProviderID = strings.TrimSpace(pool.ProviderID)
	pool.Runtime = strings.TrimSpace(pool.Runtime)
	pool.Label = strings.TrimSpace(pool.Label)
	switch {
	case pool.OwnerUserID == "":
		return errors.New("model pool owner is required")
	case pool.ProviderKind != "subscription" && pool.ProviderKind != "api" &&
		pool.ProviderKind != "environment" && pool.ProviderKind != "discovered":
		return errors.New("model pool provider kind is invalid")
	case pool.ProviderID == "":
		return errors.New("model pool provider is required")
	case pool.Runtime != "claude" && pool.Runtime != "codex":
		return errors.New("model pool runtime must be claude or codex")
	case pool.Label == "":
		return errors.New("model pool label is required")
	case len(pool.Members) == 0:
		return errors.New("model pool needs at least one model")
	}
	seen := map[string]bool{}
	for index := range pool.Members {
		member := &pool.Members[index]
		member.Model = strings.TrimSpace(member.Model)
		if member.Model == "" {
			return errors.New("model pool member model is required")
		}
		if seen[member.Model] {
			return fmt.Errorf("model pool member %s is repeated", member.Model)
		}
		seen[member.Model] = true
		if member.TokensPerMinute < 0 {
			return fmt.Errorf("model pool member %s needs a non-negative tokensPerMinute", member.Model)
		}
		if member.Weight < 0 {
			return fmt.Errorf("model pool member %s needs a non-negative weight", member.Model)
		}
		if member.Weight == 0 {
			member.Weight = 1
		}
	}
	return nil
}

func scanModelPool(row interface{ Scan(...any) error }) (store.StoredModelPool, error) {
	var pool store.StoredModelPool
	var members string
	err := row.Scan(&pool.ID, &pool.OwnerUserID, &pool.ProviderKind, &pool.ProviderID,
		&pool.Runtime, &pool.Label, &members, &pool.Cursor, &pool.CreatedAt, &pool.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoredModelPool{}, store.ErrModelPoolNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(members), &pool.Members)
	}
	return pool, err
}

func (s *Store) ListModelPools(ctx context.Context, ownerUserID string) ([]store.StoredModelPool, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+modelPoolColumns+`
		FROM model_pools WHERE owner_user_id = ? ORDER BY lower(label), id`, strings.TrimSpace(ownerUserID))
	if err != nil {
		return nil, fmt.Errorf("list model pools: %w", err)
	}
	defer rows.Close()
	pools := []store.StoredModelPool{}
	for rows.Next() {
		pool, err := scanModelPool(rows)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}
	return pools, rows.Err()
}

func (s *Store) GetModelPool(ctx context.Context, id string) (store.StoredModelPool, error) {
	pool, err := scanModelPool(s.reader().QueryRowContext(ctx, `SELECT `+modelPoolColumns+`
		FROM model_pools WHERE id = ?`, strings.TrimSpace(id)))
	if err != nil && !errors.Is(err, store.ErrModelPoolNotFound) {
		return store.StoredModelPool{}, fmt.Errorf("get model pool: %w", err)
	}
	return pool, err
}

func (s *Store) SaveModelPool(ctx context.Context, pool store.StoredModelPool) (store.StoredModelPool, error) {
	if err := normalizeModelPool(&pool); err != nil {
		return store.StoredModelPool{}, err
	}
	if pool.ID == "" {
		pool.ID = "mpool_" + uuid.NewString()
	}
	now := formatTime(time.Now().UTC())
	if pool.CreatedAt == "" {
		pool.CreatedAt = now
	}
	pool.UpdatedAt = now
	members, err := json.Marshal(pool.Members)
	if err != nil {
		return store.StoredModelPool{}, err
	}
	result, err := s.conn().ExecContext(ctx, `INSERT INTO model_pools
		(id, owner_user_id, provider_kind, provider_id, runtime, label, members_json,
			cursor, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider_kind = excluded.provider_kind,
			provider_id = excluded.provider_id,
			runtime = excluded.runtime,
			label = excluded.label,
			members_json = excluded.members_json,
			cursor = CASE WHEN model_pools.members_json = excluded.members_json
				THEN model_pools.cursor ELSE 0 END,
			updated_at = excluded.updated_at
		WHERE model_pools.owner_user_id = excluded.owner_user_id`,
		pool.ID, pool.OwnerUserID, pool.ProviderKind, pool.ProviderID, pool.Runtime, pool.Label,
		string(members), max(pool.Cursor, 0), pool.CreatedAt, pool.UpdatedAt)
	if err != nil {
		return store.StoredModelPool{}, fmt.Errorf("save model pool: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.StoredModelPool{}, store.ErrModelPoolNotFound
	}
	return s.GetModelPool(ctx, pool.ID)
}

func (s *Store) DeleteModelPool(ctx context.Context, id, ownerUserID string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM model_pools WHERE id = ? AND owner_user_id = ?`,
		strings.TrimSpace(id), strings.TrimSpace(ownerUserID))
	if err != nil {
		return fmt.Errorf("delete model pool: %w", err)
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return store.ErrModelPoolNotFound
	}
	return nil
}

func (s *Store) AdvanceModelPoolCursor(ctx context.Context, id string, memberCount int) (int, error) {
	if memberCount <= 0 {
		return 0, errors.New("model pool member count must be positive")
	}
	cursor := 0
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.conn().QueryRowContext(ctx, `SELECT cursor FROM model_pools WHERE id = ?`,
			strings.TrimSpace(id)).Scan(&cursor); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return store.ErrModelPoolNotFound
			}
			return err
		}
		_, err := tx.conn().ExecContext(ctx, `UPDATE model_pools SET cursor = ?
			WHERE id = ?`, (cursor+1)%memberCount, strings.TrimSpace(id))
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("advance model pool cursor: %w", err)
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
