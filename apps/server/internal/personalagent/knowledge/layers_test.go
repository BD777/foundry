package knowledge

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type legacyLogStore struct {
	Store
	vault          store.KnowledgeVault
	items          []store.PersonalAgentMemoryItem
	assistant      store.PersonalAgent
	noOwnedDevices bool
	copyErr        error
}

func (s legacyLogStore) GetKnowledgeVault(_ context.Context, user, id string) (store.KnowledgeVault, error) {
	if s.vault.ID != "" && s.vault.UserID == user && s.vault.ID == id {
		return s.vault, nil
	}
	return store.KnowledgeVault{}, store.ErrNotFound
}

func (s legacyLogStore) DefaultAssistant(_ context.Context, user string) (store.PersonalAgent, error) {
	if s.assistant.UserID == user {
		return s.assistant, nil
	}
	return store.PersonalAgent{}, store.ErrNotFound
}

func (s legacyLogStore) DevicesOwnedBy(context.Context, string) ([]string, error) {
	if s.noOwnedDevices {
		return nil, nil
	}
	return []string{s.assistant.HomeDeviceID}, nil
}

func (s legacyLogStore) LegacyMemoryToCopy(context.Context, int) ([]store.PersonalAgentMemoryItem, error) {
	return s.items, nil
}

func (s legacyLogStore) CopyLegacyMemory(context.Context, store.PersonalAgentMemoryItem, string) (store.KnowledgeMutation, error) {
	return store.KnowledgeMutation{}, s.copyErr
}

func TestLegacyMemoryMigrationFailuresAreLogged(t *testing.T) {
	ctx := context.Background()
	previous := log.Writer()
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(previous) })

	t.Run("layer creation", func(t *testing.T) {
		logged.Reset()
		svc := New(legacyLogStore{
			assistant:      store.PersonalAgent{ID: "asst_default", UserID: "user_layer_log", HomeDeviceID: "dev_offline"},
			noOwnedDevices: true,
		}, nil, nil, nil, nil)
		if got := svc.legacyLayer(ctx, "user_layer_log"); got != "" {
			t.Fatalf("legacy layer = %q", got)
		}
		output := logged.String()
		for _, want := range []string{"user=user_layer_log", "assistant=asst_default", "choose one of your own devices", "retrying at "} {
			if !strings.Contains(output, want) {
				t.Fatalf("log %q does not contain %q", output, want)
			}
		}
	})

	t.Run("legacy copy", func(t *testing.T) {
		logged.Reset()
		user := "user_copy_log"
		item := store.PersonalAgentMemoryItem{ID: "mem_legacy", UserID: user, AssistantID: "asst_work"}
		svc := New(legacyLogStore{
			vault:     store.KnowledgeVault{ID: MemoryLayerID(user, ""), UserID: user, Kind: "memory"},
			items:     []store.PersonalAgentMemoryItem{item},
			copyErr:   errors.New("database is locked"),
			assistant: store.PersonalAgent{ID: "asst_default", UserID: user, HomeDeviceID: "dev_home"},
		}, nil, nil, nil, nil)
		svc.drainLegacyMemory(ctx)
		output := logged.String()
		for _, want := range []string{"user=" + user, "assistant=asst_work", "database is locked", "retrying at next knowledge drain"} {
			if !strings.Contains(output, want) {
				t.Fatalf("log %q does not contain %q", output, want)
			}
		}
	})
}
