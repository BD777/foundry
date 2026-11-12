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

var _ store.ModelGuideStore = (*Store)(nil)

// setupModelGuides creates the guide tables. model_notes, the earlier
// free-text notes, was never filled in; its table is dropped.
func (s *Store) setupModelGuides(ctx context.Context) error {
	for _, statement := range []string{
		`DROP TABLE IF EXISTS model_notes`,
		`CREATE TABLE IF NOT EXISTS model_guides (
			owner_user_id TEXT NOT NULL,
			id TEXT NOT NULL,
			maker TEXT NOT NULL DEFAULT '',
			display_name TEXT NOT NULL,
			family TEXT NOT NULL DEFAULT '',
			sections_json TEXT NOT NULL DEFAULT '{}',
			revision INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by_user_id TEXT NOT NULL,
			updated_by_name TEXT NOT NULL,
			updated_by_session_id TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (owner_user_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS model_guide_aliases (
			owner_user_id TEXT NOT NULL,
			guide_id TEXT NOT NULL,
			provider_kind TEXT NOT NULL DEFAULT '',
			provider_id TEXT NOT NULL DEFAULT '',
			runtime TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_model_guide_aliases_key
			ON model_guide_aliases (owner_user_id, lower(model), provider_kind, provider_id, runtime)`,
		`CREATE INDEX IF NOT EXISTS idx_model_guide_aliases_guide ON model_guide_aliases (owner_user_id, guide_id)`,
		`CREATE TABLE IF NOT EXISTS model_guide_revisions (
			owner_user_id TEXT NOT NULL,
			guide_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			change_summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (owner_user_id, guide_id, revision)
		)`,
		`CREATE TABLE IF NOT EXISTS model_observations (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			guide_id TEXT NOT NULL,
			body TEXT NOT NULL,
			session_ids_json TEXT NOT NULL DEFAULT '[]',
			author_session_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_model_observations_guide
			ON model_observations (owner_user_id, guide_id, created_at DESC, id DESC)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite model guides: %w", err)
		}
	}
	return nil
}

const modelGuideColumns = `id, maker, display_name, family, sections_json, revision, updated_at,
	updated_by_user_id, updated_by_name, updated_by_session_id`

func scanModelGuide(row interface{ Scan(...any) error }) (store.ModelGuide, error) {
	var guide store.ModelGuide
	var sections string
	err := row.Scan(&guide.ID, &guide.Owner, &guide.DisplayName, &guide.Family, &sections, &guide.Revision, &guide.UpdatedAt,
		&guide.UpdatedBy.UserID, &guide.UpdatedBy.Name, &guide.UpdatedBy.SessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ModelGuide{}, store.ErrModelGuideNotFound
	}
	if err != nil {
		return store.ModelGuide{}, err
	}
	if err := json.Unmarshal([]byte(sections), &guide.Sections); err != nil {
		return store.ModelGuide{}, fmt.Errorf("decode model guide sections: %w", err)
	}
	return guide, nil
}

func (s *Store) modelGuideAliases(ctx context.Context, owner, guideID string) ([]store.ModelGuideAlias, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT provider_kind, provider_id, runtime, model
		FROM model_guide_aliases WHERE owner_user_id = ? AND guide_id = ?
		ORDER BY provider_kind, provider_id, runtime, lower(model)`, owner, guideID)
	if err != nil {
		return nil, fmt.Errorf("list model guide aliases: %w", err)
	}
	defer rows.Close()
	aliases := []store.ModelGuideAlias{}
	for rows.Next() {
		var alias store.ModelGuideAlias
		var runtime string
		if err := rows.Scan(&alias.ProviderKind, &alias.ProviderID, &runtime, &alias.Model); err != nil {
			return nil, err
		}
		alias.Runtime = store.NativeRuntimeID(runtime)
		aliases = append(aliases, alias)
	}
	return aliases, rows.Err()
}

func (s *Store) ListModelGuides(ctx context.Context, ownerUserID string) ([]store.ModelGuide, error) {
	owner := strings.TrimSpace(ownerUserID)
	rows, err := s.reader().QueryContext(ctx, `SELECT `+modelGuideColumns+` FROM model_guides
		WHERE owner_user_id = ? ORDER BY lower(display_name), id`, owner)
	if err != nil {
		return nil, fmt.Errorf("list model guides: %w", err)
	}
	guides := []store.ModelGuide{}
	for rows.Next() {
		guide, err := scanModelGuide(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		guides = append(guides, guide)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range guides {
		if guides[index].Aliases, err = s.modelGuideAliases(ctx, owner, guides[index].ID); err != nil {
			return nil, err
		}
	}
	return guides, nil
}

func (s *Store) GetModelGuide(ctx context.Context, ownerUserID, id string) (store.ModelGuide, error) {
	owner := strings.TrimSpace(ownerUserID)
	guide, err := scanModelGuide(s.reader().QueryRowContext(ctx, `SELECT `+modelGuideColumns+`
		FROM model_guides WHERE owner_user_id = ? AND id = ?`, owner, strings.TrimSpace(id)))
	if err != nil {
		return store.ModelGuide{}, err
	}
	guide.Aliases, err = s.modelGuideAliases(ctx, owner, guide.ID)
	return guide, err
}

func (s *Store) EditModelGuide(ctx context.Context, ownerUserID, id string, edit store.ModelGuideEdit) (store.ModelGuide, bool, error) {
	owner, id := strings.TrimSpace(ownerUserID), strings.TrimSpace(id)
	var saved store.ModelGuide
	changed := false
	err := s.withTx(ctx, func(tx *Store) error {
		current, err := tx.GetModelGuide(ctx, owner, id)
		exists := err == nil
		if err != nil && !errors.Is(err, store.ErrModelGuideNotFound) {
			return err
		}
		if !exists {
			current = store.ModelGuide{ID: id}
		}
		before, err := json.Marshal(guideContent(current))
		if err != nil {
			return err
		}
		next := current
		next.Aliases = append([]store.ModelGuideAlias(nil), current.Aliases...)
		if err := edit.Apply(&next); err != nil {
			return err
		}
		next.ID = id
		aliases := make([]store.ModelGuideAlias, 0, len(next.Aliases))
		seen := map[string]bool{}
		for _, alias := range next.Aliases {
			alias, err := store.NormalizeModelGuideAlias(alias)
			if err != nil {
				return err
			}
			if key := store.ModelGuideAliasKey(alias); !seen[key] {
				seen[key] = true
				aliases = append(aliases, alias)
			}
		}
		next.Aliases = aliases
		if err := store.ValidateModelGuide(next); err != nil {
			return err
		}
		after, err := json.Marshal(guideContent(next))
		if err != nil {
			return err
		}
		if exists && string(before) == string(after) {
			saved = current
			return nil
		}
		next.Revision = current.Revision + 1
		next.UpdatedAt = formatTime(time.Now())
		next.UpdatedBy = edit.UpdatedBy
		if err := tx.writeModelGuide(ctx, owner, next, edit.ChangeSummary); err != nil {
			return err
		}
		saved, changed = next, true
		return nil
	})
	return saved, changed, err
}

// guideContent is what a revision changes: everything but the stamps.
func guideContent(guide store.ModelGuide) store.ModelGuide {
	guide.Revision, guide.UpdatedAt, guide.UpdatedBy = 0, "", store.ModelGuideUpdater{}
	return guide
}

func (s *Store) writeModelGuide(ctx context.Context, owner string, guide store.ModelGuide, changeSummary string) error {
	sections, err := json.Marshal(guide.Sections)
	if err != nil {
		return err
	}
	snapshot, err := json.Marshal(guide)
	if err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO model_guides
		(owner_user_id, id, maker, display_name, family, sections_json, revision, updated_at,
		 updated_by_user_id, updated_by_name, updated_by_session_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (owner_user_id, id) DO UPDATE SET maker = excluded.maker, display_name = excluded.display_name,
			family = excluded.family, sections_json = excluded.sections_json, revision = excluded.revision,
			updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id,
			updated_by_name = excluded.updated_by_name, updated_by_session_id = excluded.updated_by_session_id`,
		owner, guide.ID, guide.Owner, guide.DisplayName, guide.Family, string(sections), guide.Revision, guide.UpdatedAt,
		guide.UpdatedBy.UserID, guide.UpdatedBy.Name, guide.UpdatedBy.SessionID); err != nil {
		return fmt.Errorf("save model guide: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM model_guide_aliases WHERE owner_user_id = ? AND guide_id = ?`, owner, guide.ID); err != nil {
		return fmt.Errorf("replace model guide aliases: %w", err)
	}
	for _, alias := range guide.Aliases {
		var other string
		err := s.conn().QueryRowContext(ctx, `SELECT guide_id FROM model_guide_aliases
			WHERE owner_user_id = ? AND lower(model) = lower(?) AND provider_kind = ? AND provider_id = ? AND runtime = ?`,
			owner, alias.Model, alias.ProviderKind, alias.ProviderID, string(alias.Runtime)).Scan(&other)
		if err == nil {
			return fmt.Errorf("%w: %s is already an alias of guide %s", store.ErrModelGuideAliasTaken, aliasLabel(alias), other)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := s.conn().ExecContext(ctx, `INSERT INTO model_guide_aliases
			(owner_user_id, guide_id, provider_kind, provider_id, runtime, model) VALUES (?, ?, ?, ?, ?, ?)`,
			owner, guide.ID, alias.ProviderKind, alias.ProviderID, string(alias.Runtime), alias.Model); err != nil {
			return fmt.Errorf("save model guide alias: %w", err)
		}
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO model_guide_revisions
		(owner_user_id, guide_id, revision, snapshot_json, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		owner, guide.ID, guide.Revision, string(snapshot), strings.TrimSpace(changeSummary), guide.UpdatedAt); err != nil {
		return fmt.Errorf("save model guide revision: %w", err)
	}
	return nil
}

func aliasLabel(alias store.ModelGuideAlias) string {
	parts := []string{}
	for _, part := range []string{alias.ProviderKind, alias.ProviderID, string(alias.Runtime)} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	parts = append(parts, alias.Model)
	return strings.Join(parts, "/")
}

func (s *Store) ListModelGuideRevisions(ctx context.Context, ownerUserID, id string) ([]store.ModelGuideRevisionSummary, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT revision, change_summary, snapshot_json FROM model_guide_revisions
		WHERE owner_user_id = ? AND guide_id = ? ORDER BY revision DESC`, strings.TrimSpace(ownerUserID), strings.TrimSpace(id))
	if err != nil {
		return nil, fmt.Errorf("list model guide revisions: %w", err)
	}
	defer rows.Close()
	revisions := []store.ModelGuideRevisionSummary{}
	for rows.Next() {
		var item store.ModelGuideRevisionSummary
		var snapshot string
		if err := rows.Scan(&item.Revision, &item.ChangeSummary, &snapshot); err != nil {
			return nil, err
		}
		var guide store.ModelGuide
		if err := json.Unmarshal([]byte(snapshot), &guide); err != nil {
			return nil, fmt.Errorf("decode model guide revision: %w", err)
		}
		item.UpdatedAt, item.UpdatedBy = guide.UpdatedAt, guide.UpdatedBy
		revisions = append(revisions, item)
	}
	return revisions, rows.Err()
}

func (s *Store) GetModelGuideRevision(ctx context.Context, ownerUserID, id string, revision int) (store.ModelGuideRevision, error) {
	var snapshot, summary string
	err := s.reader().QueryRowContext(ctx, `SELECT snapshot_json, change_summary FROM model_guide_revisions
		WHERE owner_user_id = ? AND guide_id = ? AND revision = ?`, strings.TrimSpace(ownerUserID), strings.TrimSpace(id), revision).Scan(&snapshot, &summary)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ModelGuideRevision{}, store.ErrModelGuideRevisionNotFound
	}
	if err != nil {
		return store.ModelGuideRevision{}, err
	}
	result := store.ModelGuideRevision{GuideID: strings.TrimSpace(id), Revision: revision, ChangeSummary: summary}
	if err := json.Unmarshal([]byte(snapshot), &result.Snapshot); err != nil {
		return store.ModelGuideRevision{}, fmt.Errorf("decode model guide revision: %w", err)
	}
	return result, nil
}

func (s *Store) ResolveModelGuide(ctx context.Context, ownerUserID string, target store.ModelGuideAlias) (store.ModelGuide, store.ModelGuideAlias, bool, error) {
	owner := strings.TrimSpace(ownerUserID)
	var guideID string
	var alias store.ModelGuideAlias
	var runtime string
	err := s.reader().QueryRowContext(ctx, `SELECT guide_id, provider_kind, provider_id, runtime, model FROM model_guide_aliases
		WHERE owner_user_id = ? AND lower(model) = lower(?)
			AND (? = '' OR provider_kind = '' OR provider_kind = ?)
			AND (? = '' OR provider_id = '' OR provider_id = ?)
			AND (? = '' OR runtime = '' OR runtime = ?)
		ORDER BY (provider_kind <> '') + (provider_id <> '') + (runtime <> '') DESC, guide_id LIMIT 1`,
		owner, strings.TrimSpace(target.Model),
		target.ProviderKind, target.ProviderKind, target.ProviderID, target.ProviderID,
		string(target.Runtime), string(target.Runtime)).Scan(&guideID, &alias.ProviderKind, &alias.ProviderID, &runtime, &alias.Model)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ModelGuide{}, store.ModelGuideAlias{}, false, nil
	}
	if err != nil {
		return store.ModelGuide{}, store.ModelGuideAlias{}, false, fmt.Errorf("resolve model guide: %w", err)
	}
	alias.Runtime = store.NativeRuntimeID(runtime)
	guide, err := s.GetModelGuide(ctx, owner, guideID)
	return guide, alias, err == nil, err
}

func (s *Store) AppendModelObservation(ctx context.Context, ownerUserID string, observation store.ModelObservation) (store.ModelObservation, error) {
	owner := strings.TrimSpace(ownerUserID)
	observation.Body = strings.TrimSpace(observation.Body)
	switch {
	case observation.Body == "":
		return store.ModelObservation{}, fmt.Errorf("%w: observation body is required", store.ErrModelGuideInvalid)
	case len(observation.Body) > store.MaxModelObservationBody:
		return store.ModelObservation{}, fmt.Errorf("%w: observation body is too long (maximum %d bytes)", store.ErrModelGuideInvalid, store.MaxModelObservationBody)
	}
	if _, err := s.GetModelGuide(ctx, owner, observation.GuideID); err != nil {
		return store.ModelObservation{}, err
	}
	sessionIDs := make([]string, 0, len(observation.SessionIDs))
	for _, id := range observation.SessionIDs {
		if id = strings.TrimSpace(id); id != "" {
			sessionIDs = append(sessionIDs, id)
		}
	}
	encoded, err := json.Marshal(sessionIDs)
	if err != nil {
		return store.ModelObservation{}, err
	}
	observation.ID = "mobs_" + uuid.NewString()
	observation.SessionIDs = sessionIDs
	observation.CreatedAt = formatTime(time.Now())
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO model_observations
		(id, owner_user_id, guide_id, body, session_ids_json, author_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		observation.ID, owner, observation.GuideID, observation.Body, string(encoded), observation.AuthorSessionID, observation.CreatedAt); err != nil {
		return store.ModelObservation{}, fmt.Errorf("append model observation: %w", err)
	}
	return observation, nil
}

func (s *Store) ListModelObservations(ctx context.Context, filter store.ModelObservationFilter) ([]store.ModelObservation, int, error) {
	owner, guideID := strings.TrimSpace(filter.OwnerUserID), strings.TrimSpace(filter.GuideID)
	var total int
	if err := s.reader().QueryRowContext(ctx, `SELECT count(*) FROM model_observations WHERE owner_user_id = ? AND guide_id = ?`,
		owner, guideID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count model observations: %w", err)
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id, guide_id, body, session_ids_json, author_session_id, created_at
		FROM model_observations WHERE owner_user_id = ? AND guide_id = ?
		ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, owner, guideID, limit, max(filter.Offset, 0))
	if err != nil {
		return nil, 0, fmt.Errorf("list model observations: %w", err)
	}
	defer rows.Close()
	observations := []store.ModelObservation{}
	for rows.Next() {
		var item store.ModelObservation
		var sessionIDs string
		if err := rows.Scan(&item.ID, &item.GuideID, &item.Body, &sessionIDs, &item.AuthorSessionID, &item.CreatedAt); err != nil {
			return nil, 0, err
		}
		if err := json.Unmarshal([]byte(sessionIDs), &item.SessionIDs); err != nil {
			return nil, 0, fmt.Errorf("decode model observation sessions: %w", err)
		}
		observations = append(observations, item)
	}
	return observations, total, rows.Err()
}

func (s *Store) ModelUsage(ctx context.Context, since time.Time, ownerUserID string, targets []store.ModelUsageTarget) (store.ModelUsage, error) {
	if len(targets) == 0 {
		return store.ModelUsage{}, nil
	}
	args := []any{formatTime(since), strings.TrimSpace(ownerUserID)}
	clauses := make([]string, 0, len(targets))
	for _, target := range targets {
		clauses = append(clauses, `(lower(model) = lower(?) AND (? = '' OR profile_id = ?) AND (? = '' OR runtime = ?))`)
		args = append(args, strings.TrimSpace(target.Model), target.ProfileID, target.ProfileID, target.Runtime, target.Runtime)
	}
	// A worker session is one a session or an Issue started.
	var usage store.ModelUsage
	err := s.reader().QueryRowContext(ctx, `SELECT
			COUNT(DISTINCT CASE WHEN parent_session_id <> '' OR entry IN ('chat_child', 'assistant_helper', 'issue') THEN session_id END),
			COUNT(*),
			COALESCE(SUM(CASE WHEN request_ms > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN request_ms > 0 THEN request_ms ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN generation_ms > 0 AND timing_estimated = 0 THEN output_tokens ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN generation_ms > 0 AND timing_estimated = 0 THEN generation_ms ELSE 0 END), 0)
		FROM usage_requests WHERE at >= ? AND user_id = ? AND (`+strings.Join(clauses, " OR ")+`)`, args...).Scan(
		&usage.WorkerSessions, &usage.Requests, &usage.TimedRequests, &usage.RequestMs, &usage.ThroughputTokens, &usage.GenerationMs)
	if err != nil {
		return store.ModelUsage{}, fmt.Errorf("sum model usage: %w", err)
	}
	return usage, nil
}
