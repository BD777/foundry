package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupKnowledge(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS knowledge_vaults(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,assistant_id TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,workspace_id TEXT NOT NULL,device_id TEXT NOT NULL,root_path TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(device_id,workspace_id,root_path))`); err != nil {
		return err
	}
	for _, column := range []string{"assistant_id", "scope"} {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE knowledge_vaults ADD COLUMN `+column+` TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("migrate knowledge_vaults %s: %w", column, err)
		}
	}
	for _, q := range []string{
		// DEV-191 P2: the one memory vault a person had (keyed by person, then
		// backfilled to their default assistant by A1) becomes their person
		// layer. Rows written since carry their scope, so this runs once.
		`UPDATE knowledge_vaults SET scope='person',assistant_id='' WHERE kind='memory' AND scope=''`,
		`DROP INDEX IF EXISTS idx_knowledge_primary`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_memory_layer ON knowledge_vaults(user_id,scope,assistant_id) WHERE kind='memory'`,
		`CREATE INDEX IF NOT EXISTS idx_knowledge_vaults_assistant ON knowledge_vaults(assistant_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge_vaults(user_id,workspace_id) WHERE kind='domain'`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
func scanKnowledgeVault(row interface{ Scan(...any) error }) (store.KnowledgeVault, error) {
	var v store.KnowledgeVault
	var raw, assistantID, scope string
	err := row.Scan(&v.UserID, &assistantID, &scope, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	// The columns own the layer: payloads written before P2 have none.
	v.AssistantID, v.Scope = assistantID, scope
	return v, err
}

const knowledgeVaultColumns = `user_id,assistant_id,scope,payload_json`

func (s *Store) GetKnowledgeVault(ctx context.Context, user, id string) (store.KnowledgeVault, error) {
	return scanKnowledgeVault(s.reader().QueryRowContext(ctx, `SELECT `+knowledgeVaultColumns+` FROM knowledge_vaults WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) CreateKnowledgeVault(ctx context.Context, v store.KnowledgeVault) (store.KnowledgeVault, error) {
	if v.ID == "" || v.UserID == "" || v.WorkspaceID == "" || v.DeviceID == "" || v.RootPath == "" || (v.Kind != "memory" && v.Kind != "domain") {
		return v, fmt.Errorf("incomplete knowledge location")
	}
	switch {
	case v.Kind == "domain":
		v.AssistantID, v.Scope = "", ""
	case v.AssistantID == "":
		v.Scope = store.MemoryScopePerson
	default:
		v.Scope = store.MemoryScopeAssistant
	}
	var saved store.KnowledgeVault
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.DeviceID); err != nil {
			return err
		}
		old, err := tx.GetKnowledgeVault(ctx, v.UserID, v.ID)
		if err == nil {
			if old.Kind != v.Kind || old.AssistantID != v.AssistantID || old.WorkspaceID != v.WorkspaceID || old.DeviceID != v.DeviceID || old.RootPath != v.RootPath {
				return store.ErrIdempotencyConflict
			}
			saved = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		v.Epoch, v.Revision, v.State, v.Reason = 1, 1, "pending", ""
		v.CreatedAt, v.UpdatedAt = paNow(), paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_vaults(id,user_id,assistant_id,scope,kind,workspace_id,device_id,root_path,revision,state,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, v.ID, v.UserID, v.AssistantID, v.Scope, v.Kind, v.WorkspaceID, v.DeviceID, v.RootPath, v.Revision, v.State, string(raw))
		saved = v
		return err
	})
	return saved, err
}
func (s *Store) SaveKnowledgeVault(ctx context.Context, v store.KnowledgeVault) (store.KnowledgeVault, error) {
	var saved store.KnowledgeVault
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.DeviceID); err != nil {
			return err
		}
		old, err := tx.GetKnowledgeVault(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision {
			return store.ErrPersonalAgentRevision
		}
		if old.WorkspaceID != v.WorkspaceID || old.DeviceID != v.DeviceID || old.RootPath != v.RootPath || old.Epoch != v.Epoch || old.Kind != v.Kind {
			return fmt.Errorf("knowledge location changes require explicit migration")
		}
		if v.State != "pending" && v.State != "active" && v.State != "waiting" && v.State != "migrating" && v.State != "frozen" && v.State != "activating" {
			return fmt.Errorf("invalid knowledge state")
		}
		v.Revision++
		v.CreatedAt = old.CreatedAt
		v.UpdatedAt = paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_vaults SET revision=?,state=?,payload_json=? WHERE user_id=? AND id=?`, v.Revision, v.State, string(raw), v.UserID, v.ID)
		saved = v
		return err
	})
	return saved, err
}
func (s *Store) queryKnowledgeVaults(ctx context.Context, where string, args ...any) ([]store.KnowledgeVault, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+knowledgeVaultColumns+` FROM knowledge_vaults WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.KnowledgeVault{}
	for rows.Next() {
		v, err := scanKnowledgeVault(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
func (s *Store) ListKnowledgeVaults(ctx context.Context, user string) ([]store.KnowledgeVault, error) {
	return s.queryKnowledgeVaults(ctx, `user_id=? ORDER BY id`, user)
}
func (s *Store) PendingKnowledgeVaults(ctx context.Context) ([]store.KnowledgeVault, error) {
	return s.queryKnowledgeVaults(ctx, `state IN ('pending','waiting') ORDER BY id LIMIT 20`)
}

// Before the Server has ever acknowledged a writable source, changing a failed
// initial choice moves only the pointer and undelivered outboxes. A late old
// initialize can create an empty marker, but no old-epoch fact write was enabled.
func (s *Store) ResetPendingKnowledgeVault(ctx context.Context, v store.KnowledgeVault) (store.KnowledgeVault, error) {
	var result store.KnowledgeVault
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.DeviceID); err != nil {
			return err
		}
		old, e := tx.GetKnowledgeVault(ctx, v.UserID, v.ID)
		if e != nil {
			return e
		}
		if old.WorkspaceID == v.WorkspaceID && old.DeviceID == v.DeviceID && old.RootPath == v.RootPath {
			result = old
			return nil
		}
		if old.Revision != v.Revision || old.Epoch != v.Epoch || (old.State != "pending" && old.State != "waiting") {
			return store.ErrPersonalAgentRevision
		}
		if old.Kind != v.Kind || (old.Kind == "domain" && old.WorkspaceID != v.WorkspaceID) {
			return fmt.Errorf("a domain source keeps its owner workspace")
		}
		var begun bool
		e = tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_entries WHERE user_id=? AND vault_id=? AND json_extract(payload_json,'$.revision')>0) OR EXISTS(SELECT 1 FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND status IN ('writing','applied'))`, v.UserID, v.ID, v.UserID, v.ID).Scan(&begun)
		if e != nil {
			return e
		}
		if begun {
			return fmt.Errorf("source work already began; wait for its receipt or use explicit migration")
		}
		v.Epoch = old.Epoch + 1
		v.Revision = old.Revision + 1
		v.State = "pending"
		v.Reason = ""
		v.CreatedAt = old.CreatedAt
		v.UpdatedAt = paNow()
		raw, e := json.Marshal(v)
		if e != nil {
			return e
		}
		_, e = tx.conn().ExecContext(ctx, `UPDATE knowledge_vaults SET workspace_id=?,device_id=?,root_path=?,revision=?,state=?,payload_json=? WHERE user_id=? AND id=? AND revision=?`, v.WorkspaceID, v.DeviceID, v.RootPath, v.Revision, v.State, string(raw), v.UserID, v.ID, old.Revision)
		if e != nil {
			return e
		}
		if _, e = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET revision=revision+1,lease_until='',payload_json=json_set(payload_json,'$.epoch',?,'$.revision',revision+1,'$.reason','authority_initialization_changed') WHERE user_id=? AND vault_id=? AND status IN ('pending','waiting')`, v.Epoch, v.UserID, v.ID); e != nil {
			return e
		}
		if _, e = tx.conn().ExecContext(ctx, `UPDATE knowledge_entries SET payload_json=json_set(payload_json,'$.epoch',?) WHERE user_id=? AND vault_id=?`, v.Epoch, v.UserID, v.ID); e != nil {
			return e
		}
		result = v
		return nil
	})
	return result, err
}
