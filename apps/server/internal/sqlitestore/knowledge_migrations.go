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

func (s *Store) setupKnowledgeMigrations(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS knowledge_migrations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,vault_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,lease_until TEXT NOT NULL DEFAULT '',target_device TEXT NOT NULL,target_workspace TEXT NOT NULL,target_path TEXT NOT NULL,payload_json TEXT NOT NULL)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_move_owner ON knowledge_migrations(user_id,vault_id) WHERE state NOT IN ('complete','cancelled')`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_move_target ON knowledge_migrations(target_device,target_workspace,target_path) WHERE state NOT IN ('complete','cancelled')`,
		`CREATE TABLE IF NOT EXISTS knowledge_replicas(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,vault_id TEXT NOT NULL,payload_json TEXT NOT NULL)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
func scanKnowledgeMigration(row interface{ Scan(...any) error }) (store.KnowledgeMigration, error) {
	var v store.KnowledgeMigration
	var raw string
	err := row.Scan(&v.UserID, &v.LeaseUntil, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	v.Source.UserID, v.Target.UserID = v.UserID, v.UserID
	return v, err
}
func (s *Store) GetKnowledgeMigration(ctx context.Context, user, id string) (store.KnowledgeMigration, error) {
	return scanKnowledgeMigration(s.reader().QueryRowContext(ctx, `SELECT user_id,lease_until,payload_json FROM knowledge_migrations WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) BeginKnowledgeMigration(ctx context.Context, v store.KnowledgeMigration, expected int64) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.Target.DeviceID); err != nil {
			return err
		}
		old, err := tx.GetKnowledgeMigration(ctx, v.UserID, v.ID)
		if err == nil {
			if old.VaultID != v.VaultID || old.Target.DeviceID != v.Target.DeviceID || old.Target.WorkspaceID != v.Target.WorkspaceID || old.Target.RootPath != v.Target.RootPath {
				return store.ErrIdempotencyConflict
			}
			saved = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if root.Revision != expected || root.State != "active" {
			return store.ErrPersonalAgentRevision
		}
		if root.DeviceID == v.Target.DeviceID && root.WorkspaceID == v.Target.WorkspaceID && root.RootPath == v.Target.RootPath {
			return fmt.Errorf("the destination is already the source")
		}
		var occupied bool
		if err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_vaults WHERE device_id=? AND workspace_id=? AND root_path=?)`, v.Target.DeviceID, v.Target.WorkspaceID, v.Target.RootPath).Scan(&occupied); err != nil {
			return err
		}
		if occupied {
			return fmt.Errorf("the destination belongs to another knowledge authority")
		}
		if err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND status IN ('pending','waiting','writing'))`, v.UserID, v.VaultID).Scan(&occupied); err != nil {
			return err
		}
		if occupied {
			return fmt.Errorf("finish or reconcile pending source writes before migration")
		}
		v.Source = root
		v.Target.ID, v.Target.UserID, v.Target.Kind, v.Target.Epoch = root.ID, root.UserID, root.Kind, root.Epoch+1
		v.State, v.Revision, v.Cursor, v.CancelRequested = "pending", 1, 0, false
		v.SourceControlRevision, v.TargetControlRevision = 0, 0
		v.Manifest = nil
		v.Reason, v.LeaseUntil = "", ""
		v.CreatedAt, v.UpdatedAt = paNow(), paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_migrations(id,user_id,vault_id,state,revision,target_device,target_workspace,target_path,payload_json) VALUES(?,?,?,?,?,?,?,?,?)`, v.ID, v.UserID, v.VaultID, v.State, v.Revision, v.Target.DeviceID, v.Target.WorkspaceID, v.Target.RootPath, string(raw))
		if err != nil {
			return err
		}
		root.State, root.Reason = "migrating", ""
		if _, err = tx.SaveKnowledgeVault(ctx, root); err != nil {
			return err
		}
		saved = v
		return nil
	})
	return saved, err
}
func (s *Store) writeKnowledgeMigration(ctx context.Context, v store.KnowledgeMigration) (store.KnowledgeMigration, error) {
	for _, doc := range v.Manifest {
		if doc.Body != "" {
			return v, fmt.Errorf("migration manifests contain metadata only")
		}
	}
	v.Revision++
	v.UpdatedAt = paNow()
	raw, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE knowledge_migrations SET state=?,revision=?,lease_until=?,payload_json=? WHERE user_id=? AND id=?`, v.State, v.Revision, v.LeaseUntil, string(raw), v.UserID, v.ID)
	return v, err
}
func (s *Store) SaveKnowledgeMigration(ctx context.Context, v store.KnowledgeMigration) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgeMigration(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision {
			return store.ErrPersonalAgentRevision
		}
		if old.State == "complete" || old.State == "cancelled" {
			return fmt.Errorf("migration is settled")
		}
		if !reflect.DeepEqual(old.Source, v.Source) || !reflect.DeepEqual(old.Target, v.Target) || old.VaultID != v.VaultID || old.CancelRequested != v.CancelRequested {
			return store.ErrIdempotencyConflict
		}
		allowed := old.State == v.State || (old.State == "pending" && v.State == "freezing") || (old.State == "freezing" && v.State == "copying") || (old.State == "copying" && v.State == "verifying") || (old.State == "verifying" && v.State == "copying") || (old.State == "retiring" && v.State == "complete")
		if !allowed {
			return fmt.Errorf("invalid migration transition")
		}
		saved, err = tx.writeKnowledgeMigration(ctx, v)
		return err
	})
	return saved, err
}
func (s *Store) RequestKnowledgeMigrationCancel(ctx context.Context, user, id string, revision int64) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		v, err := tx.GetKnowledgeMigration(ctx, user, id)
		if err != nil {
			return err
		}
		if v.Revision != revision {
			return store.ErrPersonalAgentRevision
		}
		if v.State == "activating" || v.State == "retiring" || v.State == "complete" || v.State == "cancelled" {
			return fmt.Errorf("the authority switched; finish recovery on the new source")
		}
		v.CancelRequested = true
		v.LeaseUntil = ""
		saved, err = tx.writeKnowledgeMigration(ctx, v)
		return err
	})
	return saved, err
}
func (s *Store) putKnowledgeReplica(ctx context.Context, user, vault, id string, location store.KnowledgeVault) error {
	v := store.KnowledgeReplica{ID: id, UserID: user, VaultID: vault, Location: location, CreatedAt: paNow()}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO knowledge_replicas(id,user_id,vault_id,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, user, vault, string(raw))
	return err
}
func (s *Store) SwitchKnowledgeAuthority(ctx context.Context, v store.KnowledgeMigration) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.Target.DeviceID); err != nil {
			return err
		}
		old, err := tx.GetKnowledgeMigration(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision || old.State != "verifying" || old.CancelRequested {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if root.Epoch != v.Source.Epoch || root.State != "migrating" {
			return store.ErrPersonalAgentRevision
		}
		entries, err := tx.ListKnowledgeEntries(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		byID := map[string]store.KnowledgeDocument{}
		for _, doc := range old.Manifest {
			if doc.Body != "" {
				return fmt.Errorf("unexpected body in manifest")
			}
			byID[doc.ID] = doc
		}
		for _, entry := range entries {
			doc, ok := byID[entry.ID]
			if !ok {
				if entry.State == "forgetting" || entry.State == "forgotten" {
					entry.Epoch = v.Target.Epoch
					if err = tx.saveKnowledgeEntry(ctx, v.UserID, entry); err != nil {
						return err
					}
					continue
				}
				return fmt.Errorf("source manifest is missing indexed knowledge")
			}
			if entry.State != "forgetting" && entry.State != "forgotten" && (entry.Revision != doc.Revision || entry.Hash != doc.Hash || entry.SourceRef != doc.SourceRef || entry.SourceVersion != doc.SourceVersion || entry.ExpiresAt != doc.ExpiresAt || doc.Deleted) {
				return fmt.Errorf("source index changed during verification")
			}
			entry.Epoch = v.Target.Epoch
			entry.Revision, entry.Hash = doc.Revision, doc.Hash
			if doc.Deleted {
				entry.State, entry.Title, entry.SourceRef, entry.SourceVersion, entry.ExpiresAt = "forgotten", "", "", "", ""
			}
			if err = tx.saveKnowledgeEntry(ctx, v.UserID, entry); err != nil {
				return err
			}
			delete(byID, entry.ID)
		}
		if len(byID) != 0 {
			return fmt.Errorf("unindexed knowledge cannot be silently adopted by migration")
		}
		root.WorkspaceID, root.DeviceID, root.RootPath, root.Epoch = v.Target.WorkspaceID, v.Target.DeviceID, v.Target.RootPath, v.Target.Epoch
		root.State, root.Reason = "activating", ""
		root.Revision++
		root.UpdatedAt = paNow()
		raw, err := json.Marshal(root)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_vaults SET workspace_id=?,device_id=?,root_path=?,revision=?,state=?,payload_json=? WHERE user_id=? AND id=?`, root.WorkspaceID, root.DeviceID, root.RootPath, root.Revision, root.State, string(raw), root.UserID, root.ID)
		if err != nil {
			return err
		}
		// References keep the exact fact version. Only its verified source epoch moves.
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_publications SET revision=revision+1,payload_json=json_set(payload_json,'$.sourceEpoch',?,'$.revision',revision+1,'$.updatedAt',?) WHERE user_id=? AND vault_id=? AND state='active'`, root.Epoch, paNow(), root.UserID, root.ID)
		if err != nil {
			return err
		}
		// A forget racing the move remains revoked and completes at the new authority.
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET revision=revision+1,lease_until='',payload_json=json_set(payload_json,'$.epoch',?,'$.revision',revision+1) WHERE user_id=? AND vault_id=? AND status IN ('pending','waiting','writing') AND json_extract(payload_json,'$.action')='forget'`, root.Epoch, root.UserID, root.ID)
		if err != nil {
			return err
		}
		if err = tx.putKnowledgeReplica(ctx, root.UserID, root.ID, v.ID+"_source", v.Source); err != nil {
			return err
		}
		old.State, old.Reason, old.LeaseUntil = "activating", "", ""
		saved, err = tx.writeKnowledgeMigration(ctx, old)
		return err
	})
	return saved, err
}
func (s *Store) ActivateKnowledgeAuthority(ctx context.Context, v store.KnowledgeMigration) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, v.Target.DeviceID); err != nil {
			return err
		}
		old, err := tx.GetKnowledgeMigration(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision || old.State != "activating" {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if root.Epoch != v.Target.Epoch || root.State != "activating" {
			return store.ErrPersonalAgentRevision
		}
		root.State = "active"
		if _, err = tx.SaveKnowledgeVault(ctx, root); err != nil {
			return err
		}
		old.State, old.Reason, old.LeaseUntil = "retiring", "", ""
		saved, err = tx.writeKnowledgeMigration(ctx, old)
		return err
	})
	return saved, err
}
func (s *Store) AbortKnowledgeMigration(ctx context.Context, v store.KnowledgeMigration) (store.KnowledgeMigration, error) {
	var saved store.KnowledgeMigration
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgeMigration(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision || !old.CancelRequested || old.State == "activating" || old.State == "retiring" || old.State == "complete" {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if root.Epoch != v.Source.Epoch {
			return store.ErrPersonalAgentRevision
		}
		root.State, root.Reason = "active", ""
		if _, err = tx.SaveKnowledgeVault(ctx, root); err != nil {
			return err
		}
		if old.State != "pending" {
			if err = tx.putKnowledgeReplica(ctx, root.UserID, root.ID, v.ID+"_staging", v.Target); err != nil {
				return err
			}
		}
		old.State, old.Reason, old.LeaseUntil = "cancelled", "", ""
		saved, err = tx.writeKnowledgeMigration(ctx, old)
		return err
	})
	return saved, err
}
func (s *Store) queryKnowledgeMigrations(ctx context.Context, where string, args ...any) ([]store.KnowledgeMigration, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT user_id,lease_until,payload_json FROM knowledge_migrations WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.KnowledgeMigration{}
	for rows.Next() {
		v, err := scanKnowledgeMigration(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (s *Store) ListKnowledgeMigrations(ctx context.Context, user string) ([]store.KnowledgeMigration, error) {
	return s.queryKnowledgeMigrations(ctx, `user_id=? ORDER BY rowid DESC LIMIT 100`, user)
}
func (s *Store) DueKnowledgeMigrations(ctx context.Context, now string) ([]store.KnowledgeMigration, error) {
	return s.queryKnowledgeMigrations(ctx, `state NOT IN ('complete','cancelled') AND (lease_until='' OR julianday(lease_until)<=julianday(?)) ORDER BY rowid LIMIT 10`, now)
}
func (s *Store) ListKnowledgeReplicas(ctx context.Context, user, vault string) ([]store.KnowledgeReplica, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT payload_json FROM knowledge_replicas WHERE user_id=? AND vault_id=? ORDER BY rowid`, user, vault)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.KnowledgeReplica{}
	for rows.Next() {
		var raw string
		var v store.KnowledgeReplica
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		v.UserID, v.Location.UserID = user, user
		items = append(items, v)
	}
	return items, rows.Err()
}
