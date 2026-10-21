package sqlitestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupKnowledgeEntries(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS knowledge_revoked_sources(user_id TEXT NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(user_id,source_hash))`,
		`CREATE TABLE IF NOT EXISTS knowledge_entries(user_id TEXT NOT NULL,vault_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(user_id,vault_id,id))`,
		`CREATE TABLE IF NOT EXISTS knowledge_mutations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,lease_until TEXT NOT NULL DEFAULT '',request_hash TEXT NOT NULL,body TEXT NOT NULL,payload_json TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_knowledge_mutations_due ON knowledge_mutations(status,lease_until)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
func scanKnowledgeEntry(row interface{ Scan(...any) error }) (store.KnowledgeEntry, error) {
	var v store.KnowledgeEntry
	var raw string
	err := row.Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	return v, err
}
func (s *Store) GetKnowledgeEntry(ctx context.Context, user, vault, id string) (store.KnowledgeEntry, error) {
	return scanKnowledgeEntry(s.reader().QueryRowContext(ctx, `SELECT payload_json FROM knowledge_entries WHERE user_id=? AND vault_id=? AND id=?`, user, vault, id))
}
func (s *Store) ListKnowledgeEntries(ctx context.Context, user, vault string) ([]store.KnowledgeEntry, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT payload_json FROM knowledge_entries WHERE user_id=? AND vault_id=? ORDER BY id LIMIT 1001`, user, vault)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.KnowledgeEntry{}
	for rows.Next() {
		v, err := scanKnowledgeEntry(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	if len(result) > 1000 {
		return nil, fmt.Errorf("knowledge_capacity_exceeded: source review required; index was not truncated")
	}
	return result, rows.Err()
}
func scanKnowledgeMutation(row interface{ Scan(...any) error }) (store.KnowledgeMutation, error) {
	var v store.KnowledgeMutation
	var raw string
	err := row.Scan(&v.UserID, &v.Body, &v.RequestHash, &v.LeaseUntil, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, store.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(raw), &v)
	return v, err
}

const knowledgeMutationColumns = `user_id,body,request_hash,lease_until,payload_json`

func (s *Store) GetKnowledgeMutation(ctx context.Context, user, id string) (store.KnowledgeMutation, error) {
	return scanKnowledgeMutation(s.reader().QueryRowContext(ctx, `SELECT `+knowledgeMutationColumns+` FROM knowledge_mutations WHERE user_id=? AND id=?`, user, id))
}
func (s *Store) CaptureKnowledgeMutation(ctx context.Context, v store.KnowledgeMutation) (store.KnowledgeMutation, error) {
	if v.ID == "" || v.EntryID == "" || v.RequestHash == "" || (v.Action != "write" && v.Action != "adopt" && v.Action != "forget") {
		return v, fmt.Errorf("invalid knowledge mutation")
	}
	var saved store.KnowledgeMutation
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgeMutation(ctx, v.UserID, v.ID)
		if err == nil {
			if old.RequestHash != v.RequestHash {
				return store.ErrIdempotencyConflict
			}
			saved = old
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		vault, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if v.Action != "forget" {
			if err := tx.assertDeviceNotRemoved(ctx, vault.DeviceID); err != nil {
				return err
			}
		}
		if vault.Epoch != v.Epoch || (v.Action != "forget" && (vault.State == "migrating" || vault.State == "frozen" || vault.State == "activating")) {
			return fmt.Errorf("knowledge authority is moving")
		}
		entry, err := tx.GetKnowledgeEntry(ctx, v.UserID, v.VaultID, v.EntryID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if v.Action != "forget" && v.SourceRef != "" {
			var revoked bool
			if err = tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_revoked_sources WHERE user_id=? AND source_hash=?)`, v.UserID, knowledgeSourceHash(v.UserID, v.SourceRef)).Scan(&revoked); err != nil {
				return err
			}
			if revoked {
				return fmt.Errorf("source_revoked: ask the person for a new confirmation instead of relearning from that old input")
			}
		}
		if v.Action != "forget" && (entry.State == "forgotten" || entry.State == "forgetting") {
			return fmt.Errorf("knowledge identity is revoked")
		}
		if v.Action == "adopt" && (entry.ID == "" || v.ExpectedRawHash == "") {
			return fmt.Errorf("source adoption requires a reviewed indexed identity")
		}
		if entry.ID == "" && v.Action != "forget" {
			var count int
			err = tx.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT id FROM knowledge_entries WHERE user_id=? AND vault_id=? UNION SELECT entry_id FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND status IN ('pending','waiting','writing'))`, v.UserID, v.VaultID, v.UserID, v.VaultID).Scan(&count)
			if err != nil {
				return err
			}
			if count >= 1000 {
				return fmt.Errorf("knowledge_capacity_reached: at most 1000 identities including revocations")
			}
		}
		if entry.Revision != v.ExpectedRevision || entry.Hash != v.ExpectedHash {
			return store.ErrPersonalAgentRevision
		}
		var active bool
		if err = tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND entry_id=? AND status IN ('pending','waiting','writing'))`, v.UserID, v.VaultID, v.EntryID).Scan(&active); err != nil {
			return err
		}
		if active && v.Action != "forget" {
			return fmt.Errorf("knowledge mutation already pending")
		}
		if v.Action == "forget" {
			refs := []string{entry.SourceRef}
			rows, e := tx.reader().QueryContext(ctx, `SELECT json_extract(payload_json,'$.sourceRef') FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND entry_id=?`, v.UserID, v.VaultID, v.EntryID)
			if e != nil {
				return e
			}
			for rows.Next() {
				var ref string
				if e = rows.Scan(&ref); e != nil {
					rows.Close()
					return e
				}
				refs = append(refs, ref)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			for _, ref := range refs {
				if ref != "" {
					if _, e = tx.conn().ExecContext(ctx, `INSERT OR IGNORE INTO knowledge_revoked_sources VALUES(?,?)`, v.UserID, knowledgeSourceHash(v.UserID, ref)); e != nil {
						return e
					}
				}
			}
			// Revoke retrieval immediately. A previously accepted write can still
			// finish on disk; the forget worker reconciles it and writes a tombstone.
			_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET status='superseded',revision=revision+1,body='',payload_json=json_set(payload_json,'$.status','superseded','$.revision',revision+1) WHERE user_id=? AND vault_id=? AND entry_id=? AND status IN ('pending','waiting','writing')`, v.UserID, v.VaultID, v.EntryID)
			if err != nil {
				return err
			}
			// Completed outboxes are not another historical copy of forgotten text.
			if _, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET body='',payload_json=json_set(payload_json,'$.title','','$.sourceRef','','$.sourceVersion','','$.expiresAt','') WHERE user_id=? AND vault_id=? AND entry_id=?`, v.UserID, v.VaultID, v.EntryID); err != nil {
				return err
			}
			entry.ID, entry.VaultID, entry.Epoch, entry.State = v.EntryID, v.VaultID, v.Epoch, "forgetting"
			entry.Title, entry.SourceRef, entry.SourceVersion, entry.ExpiresAt = "", "", "", ""
			entry.UpdatedAt = paNow()
			if err = tx.saveKnowledgeEntry(ctx, v.UserID, entry); err != nil {
				return err
			}
			v.Body, v.Title, v.SourceRef, v.SourceVersion, v.ExpiresAt = "", "", "", "", ""
		}
		v.Status, v.Revision, v.LeaseUntil = "pending", 1, ""
		v.CreatedAt, v.UpdatedAt = paNow(), paNow()
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_mutations(id,user_id,vault_id,entry_id,status,revision,request_hash,body,payload_json) VALUES(?,?,?,?,?,?,?,?,?)`, v.ID, v.UserID, v.VaultID, v.EntryID, v.Status, v.Revision, v.RequestHash, v.Body, string(raw))
		saved = v
		return err
	})
	return saved, err
}
func (s *Store) saveKnowledgeEntry(ctx context.Context, user string, v store.KnowledgeEntry) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO knowledge_entries(user_id,vault_id,id,state,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(user_id,vault_id,id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json`, user, v.VaultID, v.ID, v.State, string(raw))
	return err
}
func (s *Store) SaveKnowledgeMutation(ctx context.Context, v store.KnowledgeMutation) (store.KnowledgeMutation, error) {
	var saved store.KnowledgeMutation
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgeMutation(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision {
			return store.ErrPersonalAgentRevision
		}
		if old.Status != "pending" && old.Status != "waiting" && old.Status != "writing" {
			return fmt.Errorf("knowledge mutation is settled")
		}
		if v.Status != "waiting" && v.Status != "writing" && v.Status != "failed" {
			return fmt.Errorf("invalid knowledge mutation state")
		}
		if v.Status == "writing" {
			vault, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
			if err != nil {
				return err
			}
			if err := tx.assertDeviceNotRemoved(ctx, vault.DeviceID); err != nil {
				return err
			}
		}
		old.Status, old.Reason, old.LeaseUntil = v.Status, v.Reason, v.LeaseUntil
		old.Revision++
		old.UpdatedAt = paNow()
		raw, err := json.Marshal(old)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET status=?,revision=?,lease_until=?,payload_json=? WHERE user_id=? AND id=?`, old.Status, old.Revision, old.LeaseUntil, string(raw), old.UserID, old.ID)
		saved = old
		return err
	})
	return saved, err
}
func (s *Store) CompleteKnowledgeMutation(ctx context.Context, v store.KnowledgeMutation, doc store.KnowledgeDocument) error {
	return s.withTx(ctx, func(tx *Store) error {
		old, err := tx.GetKnowledgeMutation(ctx, v.UserID, v.ID)
		if err != nil {
			return err
		}
		if old.Revision != v.Revision || old.Status != "writing" {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, v.UserID, v.VaultID)
		if err != nil {
			return err
		}
		if root.Epoch != v.Epoch {
			return store.ErrPersonalAgentRevision
		}
		if doc.ID != v.EntryID || doc.OperationID != v.ID || doc.Deleted != (v.Action == "forget") {
			return fmt.Errorf("knowledge receipt does not match the operation")
		}
		entry := store.KnowledgeEntry{ID: doc.ID, VaultID: v.VaultID, Epoch: v.Epoch, Revision: doc.Revision, Hash: doc.Hash, Title: v.Title, SourceRef: doc.SourceRef, SourceVersion: doc.SourceVersion, ExpiresAt: doc.ExpiresAt, State: "active", UpdatedAt: doc.UpdatedAt}
		if doc.Deleted {
			entry.State = "forgotten"
		}
		if err = tx.saveKnowledgeEntry(ctx, v.UserID, entry); err != nil {
			return err
		}
		if err = tx.completeLegacyKnowledgeTransfer(ctx, v); err != nil {
			return err
		}
		old.Status, old.Body, old.Reason, old.LeaseUntil = "applied", "", "", ""
		old.ResultHash, old.ResultRevision = doc.Hash, doc.Revision
		old.Revision++
		old.UpdatedAt = paNow()
		raw, err := json.Marshal(old)
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE knowledge_mutations SET status=?,revision=?,lease_until='',body='',payload_json=? WHERE user_id=? AND id=?`, old.Status, old.Revision, string(raw), old.UserID, old.ID)
		return err
	})
}
func (s *Store) DueKnowledgeMutations(ctx context.Context, now string) ([]store.KnowledgeMutation, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+knowledgeMutationColumns+` FROM knowledge_mutations WHERE status IN ('pending','waiting','writing') AND (lease_until='' OR julianday(lease_until)<=julianday(?)) ORDER BY id LIMIT 20`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.KnowledgeMutation{}
	for rows.Next() {
		v, err := scanKnowledgeMutation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}

func (s *Store) ListKnowledgeMutations(ctx context.Context, user string) ([]store.KnowledgeMutation, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+knowledgeMutationColumns+` FROM knowledge_mutations WHERE user_id=? ORDER BY rowid DESC LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.KnowledgeMutation{}
	for rows.Next() {
		v, err := scanKnowledgeMutation(rows)
		if err != nil {
			return nil, err
		}
		v.Body = ""
		result = append(result, v)
	}
	return result, rows.Err()
}

func knowledgeSourceHash(user, ref string) string {
	sum := sha256.Sum256([]byte(user + "\x00" + ref))
	return hex.EncodeToString(sum[:])
}
