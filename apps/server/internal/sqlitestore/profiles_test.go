package sqlitestore

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func saveTestProfile(t *testing.T, db *Store, label string) store.ProfileDefinition {
	t.Helper()
	profile, err := db.SaveProfile(context.Background(), store.SaveProfileInput{
		Runtime:        "claude",
		Label:          label,
		ConnectionType: "api_key",
	})
	if err != nil {
		t.Fatalf("save profile %s: %v", label, err)
	}
	return profile
}

func TestSaveProfileMintsIdAndPersistsSettings(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()

	created, err := db.SaveProfile(ctx, store.SaveProfileInput{
		Runtime:              "codex",
		Label:                "Relay",
		ConnectionType:       "api_key",
		BaseURL:              "https://relay.example/v1",
		Model:                "gpt-5",
		PromptPrefix:         "Be terse.",
		CodexReasoningEffort: "high",
		CodexSandboxMode:     "workspace-write",
		CodexApprovalPolicy:  "on-request",
		CodexSpeed:           "fast",
		APIKey:               "never-stored-here",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if !strings.HasPrefix(created.ID, "prof_") {
		t.Fatalf("minted id %q does not use the prof_ prefix", created.ID)
	}
	if created.UpdatedAtLabel == "" {
		t.Fatal("created profile carries no updated-at label")
	}
	if created.HasCredential {
		t.Fatal("store layer claimed a credential it never sees")
	}

	loaded, err := db.GetProfile(ctx, created.ID)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	if !reflect.DeepEqual(loaded, created) {
		t.Fatalf("reloaded profile %#v differs from created %#v", loaded, created)
	}
	if loaded.BaseURL != "https://relay.example/v1" || loaded.Model != "gpt-5" || loaded.PromptPrefix != "Be terse." {
		t.Fatalf("connection settings did not round-trip: %#v", loaded)
	}
	if loaded.CodexReasoningEffort != "high" || loaded.CodexSandboxMode != "workspace-write" ||
		loaded.CodexApprovalPolicy != "on-request" || loaded.CodexSpeed != "fast" {
		t.Fatalf("codex knobs did not round-trip: %#v", loaded)
	}

	// The write-only API key must not have reached this table.
	var columns int
	if err := db.db.QueryRow(
		`SELECT COUNT(*) FROM pragma_table_info('profiles') WHERE name LIKE '%key%' OR name LIKE '%secret%' OR name LIKE '%credential%'`,
	).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatalf("profiles table exposes %d credential-shaped columns", columns)
	}
}

func TestSaveProfileUpdatesExistingRow(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	created := saveTestProfile(t, db, "Relay")

	updated, err := db.SaveProfile(ctx, store.SaveProfileInput{
		ID:                   created.ID,
		Runtime:              "claude",
		Label:                "Relay (EU)",
		ConnectionType:       "api_key",
		BaseURL:              "https://eu.relay.example",
		ClaudeEffort:         "medium",
		ClaudePermissionMode: "acceptEdits",
	})
	if err != nil {
		t.Fatalf("update profile: %v", err)
	}
	if updated.ID != created.ID {
		t.Fatalf("update minted a new id %q, want %q", updated.ID, created.ID)
	}
	if updated.Label != "Relay (EU)" || updated.BaseURL != "https://eu.relay.example" ||
		updated.ClaudeEffort != "medium" || updated.ClaudePermissionMode != "acceptEdits" {
		t.Fatalf("update did not persist: %#v", updated)
	}

	profiles, err := db.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("update created a second row: %#v", profiles)
	}
}

// Promotion hands SaveProfile the id it wants to keep, so a supplied id must
// insert when free and overwrite when taken — without rewriting created_at.
func TestSaveProfileUpsertsBySuppliedId(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()

	created, err := db.SaveProfile(ctx, store.SaveProfileInput{
		ID:             "prof_promoted",
		Runtime:        "claude",
		Label:          "Promoted",
		ConnectionType: "api_key",
	})
	if err != nil {
		t.Fatalf("insert under a supplied id: %v", err)
	}
	if created.ID != "prof_promoted" {
		t.Fatalf("supplied id was not honoured: %q", created.ID)
	}
	createdAt, firstUpdatedAt := profileTimestamps(t, db, "prof_promoted")

	overwritten, err := db.SaveProfile(ctx, store.SaveProfileInput{
		ID:             "prof_promoted",
		Runtime:        "claude",
		Label:          "Promoted (EU)",
		ConnectionType: "api_key",
		BaseURL:        "https://eu.relay.example",
	})
	if err != nil {
		t.Fatalf("overwrite under a taken id: %v", err)
	}
	if overwritten.Label != "Promoted (EU)" || overwritten.BaseURL != "https://eu.relay.example" {
		t.Fatalf("overwrite did not persist: %#v", overwritten)
	}

	secondCreatedAt, secondUpdatedAt := profileTimestamps(t, db, "prof_promoted")
	if !secondCreatedAt.Equal(createdAt) {
		t.Fatalf("created_at moved from %s to %s", createdAt, secondCreatedAt)
	}
	if !secondUpdatedAt.After(firstUpdatedAt) {
		t.Fatalf("updated_at did not advance: %s then %s", firstUpdatedAt, secondUpdatedAt)
	}

	profiles, err := db.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("upsert created a second row: %#v", profiles)
	}
}

func profileTimestamps(t *testing.T, db *Store, id string) (createdAt time.Time, updatedAt time.Time) {
	t.Helper()
	var created, updated string
	if err := db.db.QueryRow(`SELECT created_at, updated_at FROM profiles WHERE id = ?`, id).Scan(&created, &updated); err != nil {
		t.Fatalf("read profile timestamps: %v", err)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, created)
	if err != nil {
		t.Fatalf("parse created_at %q: %v", created, err)
	}
	updatedAt, err = time.Parse(time.RFC3339Nano, updated)
	if err != nil {
		t.Fatalf("parse updated_at %q: %v", updated, err)
	}
	return createdAt, updatedAt
}

func TestGetProfileUnknownIdIsNotFound(t *testing.T) {
	db := newTestStore(t)

	if _, err := db.GetProfile(context.Background(), "prof_ghost"); !errors.Is(err, store.ErrProfileNotFound) {
		t.Fatalf("get with an unknown id returned %v, want ErrProfileNotFound", err)
	}
}

func TestListProfilesOrdersByLabelThenId(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()

	if profiles, err := db.ListProfiles(ctx); err != nil || len(profiles) != 0 {
		t.Fatalf("fresh database listed %#v (err %v), want an empty slice", profiles, err)
	}
	zulu := saveTestProfile(t, db, "Zulu")
	alpha := saveTestProfile(t, db, "Alpha")

	profiles, err := db.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 2 || profiles[0].ID != alpha.ID || profiles[1].ID != zulu.ID {
		t.Fatalf("profiles are not ordered by label: %#v", profiles)
	}
}

func TestSetDeviceProfilesReplacesTheEnabledSet(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	first := saveTestProfile(t, db, "First")
	second := saveTestProfile(t, db, "Second")

	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   "dev_1",
		ProfileIDs: []string{first.ID, second.ID},
	}); err != nil {
		t.Fatalf("set device profiles: %v", err)
	}
	bindings, err := db.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles: %v", err)
	}
	if len(bindings) != 2 {
		t.Fatalf("expected both profiles enabled, got %#v", bindings)
	}
	for _, binding := range bindings {
		if !binding.Enabled || binding.DeviceID != "dev_1" {
			t.Fatalf("unexpected binding %#v", binding)
		}
	}

	// Replacement, not merge: the profile left out is no longer enabled.
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   "dev_1",
		ProfileIDs: []string{second.ID},
	}); err != nil {
		t.Fatalf("replace device profiles: %v", err)
	}
	bindings, err = db.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles: %v", err)
	}
	if len(bindings) != 1 || bindings[0].ProfileID != second.ID {
		t.Fatalf("replacement kept stale bindings: %#v", bindings)
	}

	// An empty set clears the device entirely.
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_1"}); err != nil {
		t.Fatalf("clear device profiles: %v", err)
	}
	bindings, err = db.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles: %v", err)
	}
	if len(bindings) != 0 {
		t.Fatalf("clearing left %#v behind", bindings)
	}
}

func TestSetDeviceProfilesSkipsUnknownProfileIds(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	known := saveTestProfile(t, db, "Known")

	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   "dev_1",
		ProfileIDs: []string{known.ID, "prof_ghost", known.ID},
	}); err != nil {
		t.Fatalf("set device profiles: %v", err)
	}
	bindings, err := db.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles: %v", err)
	}
	if len(bindings) != 1 || bindings[0].ProfileID != known.ID {
		t.Fatalf("expected only the known profile, got %#v", bindings)
	}
}

func TestSetDeviceProfilesRequiresADevice(t *testing.T) {
	db := newTestStore(t)

	if err := db.SetDeviceProfiles(context.Background(), store.SetDeviceProfilesInput{ProfileIDs: []string{"prof_1"}}); err == nil {
		t.Fatal("an empty device id was accepted")
	}
}

func TestListDeviceProfilesWithoutDeviceReturnsEveryBinding(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	profile := saveTestProfile(t, db, "Shared")

	for _, deviceID := range []string{"dev_1", "dev_2"} {
		if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
			DeviceID:   deviceID,
			ProfileIDs: []string{profile.ID},
		}); err != nil {
			t.Fatalf("set profiles for %s: %v", deviceID, err)
		}
	}

	bindings, err := db.ListDeviceProfiles(ctx, "")
	if err != nil {
		t.Fatalf("list every binding: %v", err)
	}
	if len(bindings) != 2 || bindings[0].DeviceID != "dev_1" || bindings[1].DeviceID != "dev_2" {
		t.Fatalf("expected one binding per device, got %#v", bindings)
	}
}

func TestDeleteProfileRemovesItsDeviceBindings(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	doomed := saveTestProfile(t, db, "Doomed")
	kept := saveTestProfile(t, db, "Kept")

	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   "dev_1",
		ProfileIDs: []string{doomed.ID, kept.ID},
	}); err != nil {
		t.Fatalf("set device profiles: %v", err)
	}
	if err := db.DeleteProfile(ctx, doomed.ID); err != nil {
		t.Fatalf("delete profile: %v", err)
	}

	if _, err := db.GetProfile(ctx, doomed.ID); !errors.Is(err, store.ErrProfileNotFound) {
		t.Fatalf("deleted profile still loads (err %v)", err)
	}
	bindings, err := db.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles: %v", err)
	}
	if len(bindings) != 1 || bindings[0].ProfileID != kept.ID {
		t.Fatalf("delete did not cascade to bindings: %#v", bindings)
	}
}

func TestDeleteProfileUnknownIdIsNotFound(t *testing.T) {
	db := newTestStore(t)

	if err := db.DeleteProfile(context.Background(), "prof_ghost"); !errors.Is(err, store.ErrProfileNotFound) {
		t.Fatalf("delete with an unknown id returned %v, want ErrProfileNotFound", err)
	}
}

// Reopening an existing database must converge on the same schema a fresh one
// gets, so the tables cannot depend on being created exactly once.
func TestProfileTablesSurviveReopen(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	ctx := context.Background()

	first := openTestStore(t, path)
	created := saveTestProfile(t, first, "Persisted")
	if err := first.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{
		DeviceID:   "dev_1",
		ProfileIDs: []string{created.ID},
	}); err != nil {
		t.Fatalf("set device profiles: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	again, err := Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer again.Close()

	profiles, err := again.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("list profiles after reopen: %v", err)
	}
	if len(profiles) != 1 || profiles[0].ID != created.ID {
		t.Fatalf("profiles did not survive reopen: %#v", profiles)
	}
	bindings, err := again.ListDeviceProfiles(ctx, "dev_1")
	if err != nil {
		t.Fatalf("list device profiles after reopen: %v", err)
	}
	if len(bindings) != 1 || bindings[0].ProfileID != created.ID {
		t.Fatalf("bindings did not survive reopen: %#v", bindings)
	}
}
