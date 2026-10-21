package sqlitestore

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) setupKnowledgeReplicaCleanup(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS knowledge_replica_forgets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,replica_id TEXT NOT NULL,vault_id TEXT NOT NULL,entry_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL,lease_until TEXT NOT NULL DEFAULT '')`)
	return err
}
func (s *Store) EnsureKnowledgeReplicaForgets(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO knowledge_replica_forgets(id,user_id,replica_id,vault_id,entry_id,state,revision) SELECT r.id||':'||e.id,r.user_id,r.id,r.vault_id,e.id,'pending',1 FROM knowledge_replicas r JOIN knowledge_entries e ON e.user_id=r.user_id AND e.vault_id=r.vault_id WHERE e.state IN ('forgetting','forgotten') ON CONFLICT(id) DO NOTHING`)
	return err
}
func (s *Store) queryKnowledgeReplicaForgets(ctx context.Context, where string, args ...any) ([]store.KnowledgeReplicaForget, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT id,user_id,replica_id,vault_id,entry_id,state,reason,revision,lease_until FROM knowledge_replica_forgets WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.KnowledgeReplicaForget{}
	for rows.Next() {
		var v store.KnowledgeReplicaForget
		if err := rows.Scan(&v.ID, &v.UserID, &v.ReplicaID, &v.VaultID, &v.EntryID, &v.State, &v.Reason, &v.Revision, &v.LeaseUntil); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (s *Store) DueKnowledgeReplicaForgets(ctx context.Context, now string) ([]store.KnowledgeReplicaForget, error) {
	return s.queryKnowledgeReplicaForgets(ctx, `state<>'complete' AND (lease_until='' OR julianday(lease_until)<=julianday(?)) ORDER BY id LIMIT 20`, now)
}
func (s *Store) ListKnowledgeReplicaForgets(ctx context.Context, user string) ([]store.KnowledgeReplicaForget, error) {
	return s.queryKnowledgeReplicaForgets(ctx, `user_id=? ORDER BY id LIMIT 1000`, user)
}
func (s *Store) SaveKnowledgeReplicaForget(ctx context.Context, v store.KnowledgeReplicaForget) (store.KnowledgeReplicaForget, error) {
	if v.State != "writing" && v.State != "waiting" && v.State != "complete" {
		return v, fmt.Errorf("invalid replica cleanup state")
	}
	result, err := s.conn().ExecContext(ctx, `UPDATE knowledge_replica_forgets SET state=?,reason=?,revision=revision+1,lease_until=? WHERE user_id=? AND id=? AND revision=? AND state<>'complete'`, v.State, v.Reason, v.LeaseUntil, v.UserID, v.ID, v.Revision)
	if err != nil {
		return v, err
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return v, store.ErrPersonalAgentRevision
	}
	v.Revision++
	return v, nil
}
