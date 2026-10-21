package sqlitestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupKnowledgeLegacyTransfer(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS knowledge_legacy_transfers(user_id TEXT NOT NULL,memory_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,mutation_id TEXT NOT NULL,body_hash TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(user_id,memory_id))`)
	return err
}
func (s *Store) TransferPersonalAgentMemory(ctx context.Context, user, id, vault, updated, reviewedHash string) (store.KnowledgeMutation, error) {
	var result store.KnowledgeMutation
	err := s.withTx(ctx, func(tx *Store) error {
		var operation, oldHash, oldVault string
		err := tx.reader().QueryRowContext(ctx, `SELECT mutation_id,body_hash,vault_id FROM knowledge_legacy_transfers WHERE user_id=? AND memory_id=?`, user, id).Scan(&operation, &oldHash, &oldVault)
		if err == nil {
			if oldHash != reviewedHash || oldVault != vault {
				return store.ErrIdempotencyConflict
			}
			result, err = tx.GetKnowledgeMutation(ctx, user, operation)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		item, err := tx.GetPersonalAgentMemory(ctx, user, id)
		if err != nil {
			return err
		}
		sum := sha256.Sum256([]byte(item.Content))
		if item.UpdatedAt != updated || hex.EncodeToString(sum[:]) != reviewedHash || (item.Status != store.PersonalAgentMemoryActive && item.Status != store.PersonalAgentMemoryPending) {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, user, vault)
		if err != nil {
			return err
		}
		if root.Kind != "memory" || root.State != "active" {
			return fmt.Errorf("main memory root is not ready")
		}
		key := flow.Key("legacy-transfer", user, id)
		entry := flow.Key("knowledge", key)
		title := []rune(item.Content)
		if len(title) > 80 {
			title = title[:80]
		}
		result, err = tx.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: key, UserID: user, VaultID: vault, EntryID: entry, Epoch: root.Epoch, Action: "write", Body: item.Content, Title: string(title), SourceRef: "legacy-memory:" + id, SourceVersion: updated + ";" + item.SourceSessionID + ";" + item.SourceInputID, RequestHash: flow.Key("legacy-transfer-request", vault, reviewedHash)})
		if err != nil {
			return err
		}
		if _, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_legacy_transfers VALUES(?,?,?,?,?,?,?)`, user, id, vault, entry, key, reviewedHash, "pending"); err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `UPDATE pa_memory SET status='transferring',updated_at=? WHERE user_id=? AND id=?`, paNow(), user, id)
		return err
	})
	return result, err
}
func (s *Store) completeLegacyKnowledgeTransfer(ctx context.Context, mutation store.KnowledgeMutation) error {
	var id, status string
	err := s.reader().QueryRowContext(ctx, `SELECT memory_id,status FROM knowledge_legacy_transfers WHERE user_id=? AND mutation_id=?`, mutation.UserID, mutation.ID).Scan(&id, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if status != "pending" {
		return nil
	}
	if err = s.eraseLegacyMemoryChain(ctx, mutation.UserID, id); err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE knowledge_legacy_transfers SET status='complete' WHERE user_id=? AND memory_id=?`, mutation.UserID, id)
	return err
}
func (s *Store) forgetLegacyTransfer(ctx context.Context, user, id string) error {
	var vault, entry string
	err := s.reader().QueryRowContext(ctx, `SELECT vault_id,entry_id FROM knowledge_legacy_transfers WHERE user_id=? AND memory_id=?`, user, id).Scan(&vault, &entry)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	v, err := s.GetKnowledgeVault(ctx, user, vault)
	if err != nil {
		return err
	}
	e, err := s.GetKnowledgeEntry(ctx, user, vault, entry)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if e.State != "forgetting" && e.State != "forgotten" {
		key := flow.Key("legacy-forget", user, id)
		_, err = s.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: key, UserID: user, VaultID: vault, EntryID: entry, Epoch: v.Epoch, Action: "forget", ExpectedRevision: e.Revision, ExpectedHash: e.Hash, RequestHash: key})
		if err != nil {
			return err
		}
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE knowledge_legacy_transfers SET status='forgetting' WHERE user_id=? AND memory_id=?`, user, id)
	return err
}
