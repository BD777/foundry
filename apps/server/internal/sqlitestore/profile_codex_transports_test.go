package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestCodexTransportIsLearnedPerProfileAndBaseURL(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	input := store.SaveProfileInput{
		Runtime:        "codex",
		Label:          "Gateway",
		AuthMode:       "custom",
		ConnectionType: "openai_compatible",
		BaseURL:        "https://gw.example/v1",
	}
	profile, err := db.SaveProfile(ctx, input)
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if profile.CodexTransport != store.CodexTransportAuto || profile.CodexTransportLearned != nil {
		t.Fatalf("a new compatible Codex profile is auto with nothing learned, got %q %+v", profile.CodexTransport, profile.CodexTransportLearned)
	}
	learned := func() *store.CodexTransportObservation {
		t.Helper()
		loaded, err := db.GetProfile(ctx, profile.ID)
		if err != nil {
			t.Fatalf("get profile: %v", err)
		}
		return loaded.CodexTransportLearned
	}

	if err := db.RecordCodexTransport(ctx, profile.ID, "https://gw.example/v1", store.CodexTransportObservation{Transport: store.CodexTransportHTTPS, Detail: "404"}); err != nil {
		t.Fatalf("record: %v", err)
	}
	if got := learned(); got == nil || got.Transport != store.CodexTransportHTTPS || got.Detail != "404" || got.LearnedAt == "" {
		t.Fatalf("learned = %+v, want https with its reason and time", got)
	}
	listed, err := db.ListProfiles(ctx)
	if err != nil || len(listed) != 1 || listed[0].CodexTransportLearned == nil {
		t.Fatalf("the list carries what was learned: %+v %v", listed, err)
	}

	// Another base URL is not this endpoint: nothing is kept for it.
	if err := db.RecordCodexTransport(ctx, profile.ID, "https://other.example/v1", store.CodexTransportObservation{Transport: store.CodexTransportWebSocket}); err != nil {
		t.Fatalf("record other: %v", err)
	}
	if got := learned(); got.Transport != store.CodexTransportHTTPS {
		t.Fatalf("an observation for another base URL replaced this one: %+v", got)
	}

	// Older than the TTL: unknown again.
	stale := time.Now().Add(-store.CodexTransportObservationTTL - time.Hour).UTC().Format(time.RFC3339Nano)
	if err := db.RecordCodexTransport(ctx, profile.ID, "https://gw.example/v1", store.CodexTransportObservation{Transport: store.CodexTransportHTTPS, LearnedAt: stale}); err != nil {
		t.Fatalf("record stale: %v", err)
	}
	if got := learned(); got != nil {
		t.Fatalf("a stale observation still counts: %+v", got)
	}

	// Editing the provider forgets what was learned; the override is kept.
	if err := db.RecordCodexTransport(ctx, profile.ID, "https://gw.example/v1", store.CodexTransportObservation{Transport: store.CodexTransportWebSocket}); err != nil {
		t.Fatalf("record: %v", err)
	}
	input.ID = profile.ID
	input.CodexTransport = store.CodexTransportHTTPS
	saved, err := db.SaveProfile(ctx, input)
	if err != nil {
		t.Fatalf("save again: %v", err)
	}
	if saved.CodexTransport != store.CodexTransportHTTPS || saved.CodexTransportLearned != nil {
		t.Fatalf("after an edit: %q %+v, want the override and nothing learned", saved.CodexTransport, saved.CodexTransportLearned)
	}

	if err := db.RecordCodexTransport(ctx, profile.ID, "https://gw.example/v1", store.CodexTransportObservation{Transport: "carrier-pigeon"}); err == nil {
		t.Fatal("an unknown transport was accepted")
	}
	if err := db.DeleteProfile(ctx, profile.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var rows int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM profile_codex_transports`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a deleted profile left %d observations (%v)", rows, err)
	}
}

func TestCodexTransportOnlyOnCompatibleCodexProfiles(t *testing.T) {
	db := newTestStore(t)
	profile, err := db.SaveProfile(context.Background(), store.SaveProfileInput{
		Runtime:        "claude",
		Label:          "Claude gateway",
		AuthMode:       "custom",
		ConnectionType: "anthropic_compatible",
		BaseURL:        "https://gw.example",
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if profile.CodexTransport != "" {
		t.Fatalf("a Claude profile has a Codex transport: %q", profile.CodexTransport)
	}
}
