package sqlitestore

import (
	"context"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// retiredPendingMigration closes the open items Needs you no longer keeps;
// version 1 is the selection below. A later version runs it again.
const (
	retiredPendingMigration = "retired-pending-sources"
	retiredPendingVersion   = 1
	// retiredPendingDetail is the resolution detail the closed items carry.
	retiredPendingDetail = "source_retired"
)

// migrateRetiredPendingSources closes, once per database, the open items of
// what Needs you no longer keeps: the upkeep items (store.PendingRetiredSources)
// and the needs_hands items the removed tool-output rules made. Those are told
// apart by what they recorded: a rule other than permission, or the transcript
// message of the tool whose output matched. A permission the runtime refused
// (its permission_denied event) has neither and stays open. Each closes as
// superseded through ResolvePendingItems, so its notices close with it.
func (s *Store) migrateRetiredPendingSources(ctx context.Context) error {
	return s.runDataMigration(ctx, retiredPendingMigration, retiredPendingVersion, func(tx *Store) error {
		return tx.closeRetiredPendingItems(ctx)
	})
}

func (s *Store) closeRetiredPendingItems(ctx context.Context) error {
	args := []any{store.PendingOpen}
	for _, source := range store.PendingRetiredSources {
		args = append(args, source)
	}
	args = append(args, store.PendingSourceNeedsHands)
	rows, err := s.conn().QueryContext(ctx, `SELECT DISTINCT source, item_key FROM pending_items WHERE state = ? AND (
		source IN (`+strings.TrimSuffix(strings.Repeat("?,", len(store.PendingRetiredSources)), ",")+`)
		OR (source = ? AND (COALESCE(json_extract(payload_json, '$.rule'), '') <> 'permission'
			OR COALESCE(json_extract(payload_json, '$.messageId'), '') <> '')))`, args...)
	if err != nil {
		return fmt.Errorf("find retired pending items: %w", err)
	}
	type retired struct{ source, key string }
	var found []retired
	for rows.Next() {
		var item retired
		if err := rows.Scan(&item.source, &item.key); err != nil {
			rows.Close()
			return err
		}
		found = append(found, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range found {
		if _, err := s.ResolvePendingItems(ctx, store.PendingResolution{
			Key: item.key, Sources: []string{item.source}, State: store.PendingSuperseded,
			ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: retiredPendingDetail,
		}); err != nil {
			return fmt.Errorf("close retired pending item %s: %w", item.key, err)
		}
	}
	return nil
}
