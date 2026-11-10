package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

func (s *Store) setupModelNotes(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS model_notes (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			provider_kind TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			runtime TEXT NOT NULL,
			model TEXT NOT NULL,
			body TEXT NOT NULL,
			author_user_id TEXT NOT NULL,
			author_name TEXT NOT NULL,
			author_session_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_model_notes_target
			ON model_notes (owner_user_id, provider_kind, provider_id, runtime, model, created_at DESC, id DESC)`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite model notes: %w", err)
		}
	}
	return nil
}

func normalizeModelNoteTarget(note *store.StoredModelNote) error {
	note.OwnerUserID = strings.TrimSpace(note.OwnerUserID)
	note.ProviderKind = strings.TrimSpace(note.ProviderKind)
	note.ProviderID = strings.TrimSpace(note.ProviderID)
	note.Runtime = strings.TrimSpace(note.Runtime)
	note.Model = strings.TrimSpace(note.Model)
	note.Body = strings.TrimSpace(note.Body)
	note.AuthorUserID = strings.TrimSpace(note.AuthorUserID)
	note.AuthorName = strings.TrimSpace(note.AuthorName)
	note.AuthorSessionID = strings.TrimSpace(note.AuthorSessionID)
	switch {
	case note.OwnerUserID == "":
		return errors.New("model note owner is required")
	case note.ProviderKind != "subscription" && note.ProviderKind != "api" && note.ProviderKind != "environment" && note.ProviderKind != "discovered":
		return errors.New("model note provider kind is invalid")
	case note.ProviderID == "":
		return errors.New("model note provider id is required")
	case note.Runtime != "claude" && note.Runtime != "codex":
		return errors.New("model note runtime must be claude or codex")
	case note.Model == "":
		return errors.New("model note model is required")
	case note.Body == "":
		return errors.New("model note body is required")
	case len(note.Body) > store.MaxModelNoteBody:
		return fmt.Errorf("model note body is too long (maximum %d bytes)", store.MaxModelNoteBody)
	case note.AuthorUserID == "":
		return errors.New("model note author is required")
	}
	return nil
}

func scanModelNote(row interface{ Scan(...any) error }) (store.StoredModelNote, error) {
	var note store.StoredModelNote
	err := row.Scan(
		&note.ID, &note.OwnerUserID, &note.ProviderKind, &note.ProviderID, &note.Runtime, &note.Model,
		&note.Body, &note.AuthorUserID, &note.AuthorName, &note.AuthorSessionID, &note.CreatedAt, &note.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoredModelNote{}, store.ErrModelNoteNotFound
	}
	return note, err
}

const modelNoteColumns = `id, owner_user_id, provider_kind, provider_id, runtime, model, body,
	author_user_id, author_name, author_session_id, created_at, updated_at`

func (s *Store) ListModelNotes(ctx context.Context, filter store.ModelNoteFilter) ([]store.StoredModelNote, int, error) {
	where := `owner_user_id = ? AND provider_kind = ? AND provider_id = ? AND runtime = ? AND model = ?`
	args := []any{strings.TrimSpace(filter.OwnerUserID), strings.TrimSpace(filter.ProviderKind),
		strings.TrimSpace(filter.ProviderID), strings.TrimSpace(filter.Runtime), strings.TrimSpace(filter.Model)}
	var total int
	if err := s.reader().QueryRowContext(ctx, `SELECT count(*) FROM model_notes WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count model notes: %w", err)
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	offset := max(filter.Offset, 0)
	rows, err := s.reader().QueryContext(ctx, `SELECT `+modelNoteColumns+` FROM model_notes WHERE `+where+
		` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list model notes: %w", err)
	}
	defer rows.Close()
	notes := []store.StoredModelNote{}
	for rows.Next() {
		note, err := scanModelNote(rows)
		if err != nil {
			return nil, 0, err
		}
		notes = append(notes, note)
	}
	return notes, total, rows.Err()
}

func (s *Store) GetModelNote(ctx context.Context, id string) (store.StoredModelNote, error) {
	return scanModelNote(s.reader().QueryRowContext(ctx, `SELECT `+modelNoteColumns+` FROM model_notes WHERE id = ?`, strings.TrimSpace(id)))
}

func (s *Store) AppendModelNote(ctx context.Context, note store.StoredModelNote) (store.StoredModelNote, error) {
	if err := normalizeModelNoteTarget(&note); err != nil {
		return store.StoredModelNote{}, err
	}
	note.ID = "mnote_" + uuid.NewString()
	now := formatTime(time.Now())
	note.CreatedAt, note.UpdatedAt = now, ""
	_, err := s.conn().ExecContext(ctx, `INSERT INTO model_notes
		(id, owner_user_id, provider_kind, provider_id, runtime, model, body,
		 author_user_id, author_name, author_session_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
		note.ID, note.OwnerUserID, note.ProviderKind, note.ProviderID, note.Runtime, note.Model, note.Body,
		note.AuthorUserID, note.AuthorName, note.AuthorSessionID, note.CreatedAt)
	if err != nil {
		return store.StoredModelNote{}, fmt.Errorf("append model note: %w", err)
	}
	return note, nil
}

func (s *Store) UpdateModelNote(ctx context.Context, id, ownerUserID, body string) (store.StoredModelNote, error) {
	body = strings.TrimSpace(body)
	switch {
	case body == "":
		return store.StoredModelNote{}, errors.New("model note body is required")
	case len(body) > store.MaxModelNoteBody:
		return store.StoredModelNote{}, fmt.Errorf("model note body is too long (maximum %d bytes)", store.MaxModelNoteBody)
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE model_notes SET body = ?, updated_at = ?
		WHERE id = ? AND owner_user_id = ?`, body, formatTime(time.Now()), strings.TrimSpace(id), strings.TrimSpace(ownerUserID))
	if err != nil {
		return store.StoredModelNote{}, fmt.Errorf("update model note: %w", err)
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return store.StoredModelNote{}, store.ErrModelNoteNotFound
	}
	return s.GetModelNote(ctx, id)
}

func (s *Store) DeleteModelNote(ctx context.Context, id, ownerUserID string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM model_notes WHERE id = ? AND owner_user_id = ?`,
		strings.TrimSpace(id), strings.TrimSpace(ownerUserID))
	if err != nil {
		return fmt.Errorf("delete model note: %w", err)
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return store.ErrModelNoteNotFound
	}
	return nil
}
