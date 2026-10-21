package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"reflect"
)

func (s *Store) setupKnowledgePublications(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS knowledge_publications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,target_workspace_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL)`)
	return err
}
func scanKnowledgePublication(row interface{ Scan(...any) error }) (store.KnowledgePublication, error) {
	var v store.KnowledgePublication
	var raw string
	err := row.Scan(&v.UserID, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	if v.Scope == "" {
		v.Scope = "entry"
	}
	return v, err
}
func (s *Store) GetKnowledgePublication(ctx context.Context, user, id string) (store.KnowledgePublication, error) {
	return scanKnowledgePublication(s.reader().QueryRowContext(ctx, `SELECT user_id,payload_json FROM knowledge_publications WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) CreateKnowledgePublication(ctx context.Context, v store.KnowledgePublication) (store.KnowledgePublication, error) {
	if v.Scope == "" {
		v.Scope = "entry"
	}
	if v.Scope != "entry" && v.Scope != "memory_root" {
		return v, fmt.Errorf("unknown publication scope")
	}
	if v.ID == "" || v.TargetWorkspaceID == "" || v.ProfileID == "" || v.ProfileFingerprint == "" || v.AudienceHash == "" || v.Purpose == "" {
		return v, fmt.Errorf("incomplete publication scope")
	}
	var saved store.KnowledgePublication
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgePublication(ctx, v.UserID, v.ID)
		if err == nil {
			a, b := old, v
			a.CreatedAt, a.UpdatedAt, a.State, a.Revision = "", "", "", 0
			b.CreatedAt, b.UpdatedAt, b.State, b.Revision = "", "", "", 0
			if !reflect.DeepEqual(a, b) {
				return store.ErrIdempotencyConflict
			}
			saved = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if v.Scope == "memory_root" {
			root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
			if err != nil {
				return err
			}
			if root.Kind != "memory" || root.Epoch != v.SourceEpoch || v.EntryID != "" || v.SourceRevision != 0 || v.SourceHash != "" {
				return fmt.Errorf("root recall requires the private main authority")
			}
		} else {
			source, err := tx.GetKnowledgeEntry(ctx, v.UserID, v.VaultID, v.EntryID)
			if err != nil {
				return err
			}
			if source.State != "active" || source.Epoch != v.SourceEpoch || source.Revision != v.SourceRevision || source.Hash != v.SourceHash {
				return store.ErrPersonalAgentRevision
			}
		}
		if v.Scope == "memory_root" {
			// Enabling the selected assistant account replaces the earlier
			// root-wide account grant, without touching individual references.
			_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_publications SET state='revoked',revision=revision+1,payload_json=json_set(payload_json,'$.state','revoked','$.revision',revision+1,'$.updatedAt',?) WHERE user_id=? AND vault_id=? AND state='active' AND json_extract(payload_json,'$.scope')='memory_root'`, paNow(), v.UserID, v.VaultID)
			if err != nil {
				return err
			}
		}
		v.State, v.Revision, v.CreatedAt, v.UpdatedAt = "active", 1, paNow(), paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_publications(id,user_id,vault_id,entry_id,target_workspace_id,state,revision,payload_json) VALUES(?,?,?,?,?,?,?,?)`, v.ID, v.UserID, v.VaultID, v.EntryID, v.TargetWorkspaceID, v.State, v.Revision, string(raw))
		saved = v
		return err
	})
	return saved, err
}

// Authorization discovery must not silently drop a current grant behind old
// revoked references. These rows contain metadata only, never fact bodies.
func (s *Store) ListKnowledgePublications(ctx context.Context, user string) ([]store.KnowledgePublication, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT user_id,payload_json FROM knowledge_publications WHERE user_id=? ORDER BY id`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.KnowledgePublication{}
	for rows.Next() {
		v, err := scanKnowledgePublication(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
func (s *Store) RevokeKnowledgePublication(ctx context.Context, user, id string, revision int64) (store.KnowledgePublication, error) {
	var saved store.KnowledgePublication
	err := s.withTx(ctx, func(tx *Store) error {
		v, err := tx.GetKnowledgePublication(ctx, user, id)
		if err != nil {
			return err
		}
		if v.Revision != revision {
			return store.ErrPersonalAgentRevision
		}
		v.State = "revoked"
		v.Revision++
		v.UpdatedAt = paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_publications SET state=?,revision=?,payload_json=? WHERE user_id=? AND id=?`, v.State, v.Revision, string(raw), user, id)
		saved = v
		return err
	})
	return saved, err
}
