package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"path/filepath"
	"testing"
)

func TestNativeAccountHoldSurvivesReportsAndExplicitResume(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "foundry.db")
	db := openTestStore(t, path)
	reg := registrationInput(t, "ws_hold", "hold")
	profile := store.AgentProfileProjection{ID: "claude_local", DeviceID: reg.Device.ID, Runtime: "claude", ConnectionType: "local_login", Origin: "device", AccountLabel: "one@example.test", Status: "healthy"}
	reg.AgentProfiles = []store.AgentProfileProjection{profile}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "sess_hold", DeviceID: reg.Device.ID, Provider: "claude", ProfileID: profile.ID, Input: store.SessionInput{ID: "first"}}
	if err := db.BindNativeAccount(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "permission_error"); err != nil {
		t.Fatal(err)
	}
	rows, _ := db.ListAgentProfiles(ctx, reg.Device.ID)
	if rows[0].AccountHold != nil {
		t.Fatal("generic permissions must not suspend an account")
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "account_on_hold"); err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	rows, err := db.ListAgentProfiles(ctx, reg.Device.ID)
	if err != nil {
		t.Fatal(err)
	}
	hold := rows[0].AccountHold
	if hold == nil || rows[0].Status != "unavailable" {
		t.Fatalf("report erased suspension: %+v", rows)
	}
	if err := db.BindNativeAccount(ctx, session); err == nil {
		t.Fatal("suspended dispatch accepted")
	}
	if err := db.ResumeNativeAccount(ctx, reg.Device.ID, profile.ID, "stale"); err == nil {
		t.Fatal("stale recovery accepted")
	}
	if err := db.ResumeNativeAccount(ctx, reg.Device.ID, profile.ID, hold.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "account_on_hold"); err != nil {
		t.Fatal(err)
	}
	rows, _ = db.ListAgentProfiles(ctx, reg.Device.ID)
	if rows[0].AccountHold != nil {
		t.Fatal("duplicate signal undid manual resume")
	}
	session.Input.ID = "second"
	if err := db.BindNativeAccount(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "account_on_hold"); err != nil {
		t.Fatal(err)
	}
	rows, _ = db.ListAgentProfiles(ctx, reg.Device.ID)
	if rows[0].AccountHold == nil || rows[0].AccountHold.ID == hold.ID {
		t.Fatal("new failure must block again with a new recovery identity")
	}
	// A login switch must not apply the previous account's block to the new one.
	reg.AgentProfiles[0].AccountLabel = "two@example.test"
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	rows, _ = db.ListAgentProfiles(ctx, reg.Device.ID)
	if rows[0].AccountHold != nil {
		t.Fatal("suspension leaked to another login")
	}
	// Reopening the database still remembers the first account's hold.
	other, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	reg.AgentProfiles[0].AccountLabel = profile.AccountLabel
	if err := other.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	rows, err = other.ListAgentProfiles(ctx, reg.Device.ID)
	if err != nil || rows[0].AccountHold == nil {
		t.Fatalf("hold lost on restart: %v %+v", err, rows)
	}
}

func TestNativeAccountSignalUsesTheDispatchedIdentity(t *testing.T) {
	ctx := context.Background()
	db := openTestStore(t, filepath.Join(t.TempDir(), "foundry.db"))
	reg := registrationInput(t, "ws_identity", "identity")
	reg.AgentProfiles = []store.AgentProfileProjection{{ID: "claude_local", DeviceID: reg.Device.ID, Runtime: "claude", ConnectionType: "local_login", AccountLabel: "old@example.test", Status: "healthy"}}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "sess_old", DeviceID: reg.Device.ID, Provider: "claude", ProfileID: "claude_local", Input: store.SessionInput{ID: "old-input"}}
	if err := db.BindNativeAccount(ctx, session); err != nil {
		t.Fatal(err)
	}
	reg.AgentProfiles[0].AccountLabel = "new@example.test"
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	if err := db.BindNativeAccount(ctx, session); err == nil {
		t.Fatal("old input must not silently change account")
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "account_on_hold"); err != nil {
		t.Fatal(err)
	}
	rows, _ := db.ListAgentProfiles(ctx, reg.Device.ID)
	if rows[0].AccountHold != nil {
		t.Fatal("late failure suspended the newly signed-in account")
	}
}
