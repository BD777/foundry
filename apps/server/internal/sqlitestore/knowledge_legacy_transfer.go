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
	if status == "copying" {
		// An automatic copy keeps its legacy row, read-only, for rollback.
		_, err = s.conn().ExecContext(ctx, `UPDATE knowledge_legacy_transfers SET status='copied' WHERE user_id=? AND memory_id=?`, mutation.UserID, id)
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

func (s *Store) LegacyMemoryToCopy(ctx context.Context, limit int) ([]store.PersonalAgentMemoryItem, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+memoryColumns+` FROM pa_memory m WHERE status=? AND origin IN (?,?) AND content<>''
		AND NOT EXISTS (SELECT 1 FROM knowledge_legacy_transfers t WHERE t.user_id=m.user_id AND t.memory_id=m.id)
		ORDER BY created_at, rowid LIMIT ?`, store.PersonalAgentMemoryActive, store.PersonalAgentMemoryStated, store.PersonalAgentMemoryEdited, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.PersonalAgentMemoryItem{}
	for rows.Next() {
		item, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) CopyLegacyMemory(ctx context.Context, item store.PersonalAgentMemoryItem, vaultID string) (store.KnowledgeMutation, error) {
	var result store.KnowledgeMutation
	err := s.withTx(ctx, func(tx *Store) error {
		var operation string
		err := tx.reader().QueryRowContext(ctx, `SELECT mutation_id FROM knowledge_legacy_transfers WHERE user_id=? AND memory_id=?`, item.UserID, item.ID).Scan(&operation)
		if err == nil {
			result, err = tx.GetKnowledgeMutation(ctx, item.UserID, operation)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		current, err := tx.GetPersonalAgentMemory(ctx, item.UserID, item.ID)
		if err != nil {
			return err
		}
		if current.Status != store.PersonalAgentMemoryActive || current.Content == "" {
			return store.ErrPersonalAgentRevision
		}
		root, err := tx.GetKnowledgeVault(ctx, item.UserID, vaultID)
		if err != nil {
			return err
		}
		if root.Kind != "memory" {
			return fmt.Errorf("legacy memory copies only into a memory layer")
		}
		key := flow.Key("legacy-copy", item.UserID, item.ID)
		entry := flow.Key("knowledge", key)
		title := []rune(current.Content)
		if len(title) > 80 {
			title = title[:80]
		}
		sum := sha256.Sum256([]byte(current.Content))
		result, err = tx.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: key, UserID: item.UserID, VaultID: vaultID, EntryID: entry, Epoch: root.Epoch, Action: "write", Body: current.Content, Title: string(title), SourceRef: "legacy-memory:" + current.ID, SourceVersion: current.UpdatedAt + ";" + current.SourceSessionID + ";" + current.SourceInputID, RequestHash: flow.Key("legacy-copy-request", vaultID, hex.EncodeToString(sum[:]))})
		if err != nil {
			return err
		}
		_, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_legacy_transfers VALUES(?,?,?,?,?,?,?)`, item.UserID, item.ID, vaultID, entry, key, hex.EncodeToString(sum[:]), "copying")
		return err
	})
	return result, err
}

func (s *Store) LegacyMemoryCopies(ctx context.Context, user string) (map[string]string, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT memory_id,status FROM knowledge_legacy_transfers WHERE user_id=?`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	copies := map[string]string{}
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		copies[id] = status
	}
	return copies, rows.Err()
}
