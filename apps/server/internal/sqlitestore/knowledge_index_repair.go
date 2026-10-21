package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Rebuild the projection from a verified device listing. Revocation is control
// state, so neither an old file nor an index repair can undo it.
func (s *Store) ReconcileKnowledgeIndex(ctx context.Context, user, vault string, epoch int64, docs []store.KnowledgeDocument) error {
	if len(docs) > 1000 {
		return fmt.Errorf("knowledge_capacity_exceeded")
	}
	return s.withTx(ctx, func(tx *Store) error {
		v, err := tx.GetKnowledgeVault(ctx, user, vault)
		if err != nil {
			return err
		}
		if v.Epoch != epoch || v.State != "active" {
			return store.ErrPersonalAgentRevision
		}
		var pending bool
		err = tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND status IN ('pending','waiting','writing'))`, user, vault).Scan(&pending)
		if err != nil {
			return err
		}
		if pending {
			return fmt.Errorf("knowledge_mutations_pending")
		}
		previous, err := tx.ListKnowledgeEntries(ctx, user, vault)
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		union := map[string]bool{}
		for _, e := range previous {
			union[e.ID] = true
		}
		for _, doc := range docs {
			if doc.ID == "" || seen[doc.ID] || doc.Revision < 1 || doc.Hash == "" {
				return fmt.Errorf("invalid source manifest")
			}
			seen[doc.ID] = true
			union[doc.ID] = true
		}
		if len(union) > 1000 {
			return fmt.Errorf("knowledge_capacity_exceeded")
		}
		for _, doc := range docs {
			old, e := tx.GetKnowledgeEntry(ctx, user, vault, doc.ID)
			if e != nil && !errors.Is(e, store.ErrNotFound) {
				return e
			}
			revoked := old.State == "forgotten" || old.State == "forgetting"
			if doc.SourceRef != "" {
				var sourceRevoked bool
				if e = tx.reader().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_revoked_sources WHERE user_id=? AND source_hash=?)`, user, knowledgeSourceHash(user, doc.SourceRef)).Scan(&sourceRevoked); e != nil {
					return e
				}
				revoked = revoked || sourceRevoked
			}
			if revoked && !doc.Deleted {
				key := flow.Key("repair-forget", user, vault, doc.ID, doc.Hash)
				_, e = tx.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: key, UserID: user, VaultID: vault, EntryID: doc.ID, Epoch: epoch, Action: "forget", ExpectedRevision: old.Revision, ExpectedHash: old.Hash, RequestHash: key})
				if e != nil {
					return e
				}
				continue
			}
			// Reindexing is recovery of a projection, not a back door around
			// manual-edit review. A changed or lost row must match the last
			// acknowledged file receipt, whose body was erased after commit.
			title := old.Title
			same := old.Revision == doc.Revision && old.Hash == doc.Hash && old.SourceRef == doc.SourceRef && old.SourceVersion == doc.SourceVersion && old.ExpiresAt == doc.ExpiresAt
			if !same && !doc.Deleted {
				receipt, e := scanKnowledgeMutation(tx.reader().QueryRowContext(ctx, `SELECT `+knowledgeMutationColumns+` FROM knowledge_mutations WHERE user_id=? AND vault_id=? AND entry_id=? AND status='applied' ORDER BY CAST(json_extract(payload_json,'$.resultRevision') AS INTEGER) DESC,rowid DESC LIMIT 1`, user, vault, doc.ID))
				if e != nil || receipt.ResultHash != doc.Hash || receipt.ResultRevision != doc.Revision || receipt.SourceRef != doc.SourceRef || receipt.SourceVersion != doc.SourceVersion || receipt.ExpiresAt != doc.ExpiresAt {
					return fmt.Errorf("source_review_required: inspect and adopt changed sources; index repair cannot confirm new facts")
				}
				title = receipt.Title
			}
			if old.Revision > doc.Revision {
				return fmt.Errorf("source_older_than_index: review the restored source before changing its authority")
			}
			next := store.KnowledgeEntry{ID: doc.ID, VaultID: vault, Epoch: epoch, Revision: doc.Revision, Hash: doc.Hash, Title: title, SourceRef: doc.SourceRef, SourceVersion: doc.SourceVersion, ExpiresAt: doc.ExpiresAt, State: "active", UpdatedAt: doc.UpdatedAt}
			if next.Title == "" {
				next.Title = doc.ID
			}
			if doc.Deleted {
				next.State = "forgotten"
				next.Title = ""
				next.SourceRef = ""
				next.SourceVersion = ""
				next.ExpiresAt = ""
			}
			if err = tx.saveKnowledgeEntry(ctx, user, next); err != nil {
				return err
			}
		}
		for _, entry := range previous {
			if !seen[entry.ID] && entry.State == "active" {
				entry.State = "missing"
				if err = tx.saveKnowledgeEntry(ctx, user, entry); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
