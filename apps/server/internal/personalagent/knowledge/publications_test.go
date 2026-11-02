package knowledge

import (
	"fmt"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestExpiredEntryIsNotCurrent(t *testing.T) {
	if entryCurrent(store.KnowledgeEntry{Epoch: 1, State: "active", ExpiresAt: "2020-01-01T00:00:00Z"}, 1) {
		t.Fatal("expired fact is current")
	}
}

func TestKnowledgeMetadataCanPagePastFiftyWithoutRevivingExpiredEntries(t *testing.T) {
	rows := []store.KnowledgeEntry{}
	for i := 120; i > 0; i-- {
		rows = append(rows, store.KnowledgeEntry{ID: fmt.Sprintf("entry%03d", i), Epoch: 2, State: "active", Title: "MATCH synthetic fact"})
	}
	rows = append(rows, store.KnowledgeEntry{ID: "expired", Epoch: 2, State: "active", Title: "MATCH", ExpiresAt: "2020-01-01T00:00:00Z"}, store.KnowledgeEntry{ID: "forgotten", Epoch: 2, State: "forgotten", Title: "MATCH"}, store.KnowledgeEntry{ID: "old-authority", Epoch: 1, State: "active", Title: "MATCH"})
	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		page, more, next := metadataPage(rows, 2, "match", cursor)
		pages++
		if len(page) > 50 {
			t.Fatal("unbounded metadata page")
		}
		for _, entry := range page {
			if seen[entry.ID] {
				t.Fatal("repeated metadata", entry.ID)
			}
			seen[entry.ID] = true
		}
		if !more {
			break
		}
		if next <= cursor {
			t.Fatal("cursor did not advance")
		}
		cursor = next
	}
	if pages != 3 || len(seen) != 120 {
		t.Fatalf("incomplete discovery: %d pages, %d entries", pages, len(seen))
	}
}
