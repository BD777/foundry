package assistant

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestMaintenancePromptRedactsThePurpose(t *testing.T) {
	prompt := maintenancePromptText("governance", "Review the project.", "Sync sk-proj-AbCdEf1234567890GhIjKlMnOp with ops@example.com using https://deploy:hunter2@example.com/job")
	for _, secret := range []string{"sk-proj-AbCdEf1234567890GhIjKlMnOp", "ops@example.com", "deploy:hunter2"} {
		if strings.Contains(prompt, secret) {
			t.Fatalf("maintenance prompt leaked %q: %s", secret, prompt)
		}
	}
	for _, placeholder := range []string{"‹secret›", "‹email›"} {
		if !strings.Contains(prompt, placeholder) {
			t.Fatalf("maintenance prompt lacks %s: %s", placeholder, prompt)
		}
	}
}

func TestMaintenanceKnowledgeIndexRedactsTextAndKeepsIdentity(t *testing.T) {
	index := maintenanceKnowledgeIndex([]store.KnowledgeEntry{{
		ID:            "entry_1",
		VaultID:       "vault_1",
		Epoch:         4,
		Revision:      7,
		Hash:          "sha256:unchanged",
		Title:         "Rotate sk-proj-AbCdEf1234567890GhIjKlMnOp",
		SourceRef:     "https://deploy:hunter2@example.com/job",
		SourceVersion: "version-3",
		State:         "active",
		UpdatedAt:     "2026-11-10T00:00:00Z",
	}})
	if strings.Contains(index, "sk-proj-AbCdEf1234567890GhIjKlMnOp") || strings.Contains(index, "deploy:hunter2") || !strings.Contains(index, "‹secret›") {
		t.Fatalf("maintenance index was not redacted: %s", index)
	}
	var entries []store.KnowledgeEntry
	if err := json.Unmarshal([]byte(index), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.ID != "entry_1" || entry.VaultID != "vault_1" || entry.Epoch != 4 || entry.Revision != 7 ||
		entry.Hash != "sha256:unchanged" || entry.SourceVersion != "version-3" || entry.UpdatedAt != "2026-11-10T00:00:00Z" {
		t.Fatalf("maintenance index changed identity fields: %+v", entry)
	}
}
