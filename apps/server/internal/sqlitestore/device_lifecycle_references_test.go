package sqlitestore

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func lifecycleAssistant(t *testing.T, db *Store) store.PersonalAgent {
	t.Helper()
	registerDeviceRemovalDaemon(t, db, "dev_old", "ws_old")
	registerDeviceRemovalDaemon(t, db, "dev_active", "ws_active")
	settings := store.PersonalAgentSettings{
		Devices:           []store.PersonalAgentDeviceSettings{{DeviceID: "dev_old", AllowWork: true, AllowCreate: true}, {DeviceID: "dev_active", AllowWork: true}},
		PreferredDeviceID: "dev_old", RunDefault: &store.PersonalAgentRunPreference{DeviceID: "dev_old", ProfileID: "explicit"},
	}
	agent, err := db.CreatePersonalAgent(context.Background(), store.PersonalAgent{UserID: "user_lifecycle", WorkspaceID: "ws_old", HomeDeviceID: "dev_old", Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	return agent
}

func TestDeviceLifecycleReferencesAndRepair(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	original := lifecycleAssistant(t, db)
	vault, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "vault_old", UserID: original.UserID, Kind: "memory", DeviceID: "dev_old", WorkspaceID: "ws_old", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
	saved, err := db.GetPersonalAgent(ctx, original.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Settings.Devices) != 1 || saved.Settings.Devices[0].DeviceID != "dev_active" || !saved.Settings.Devices[0].AllowWork {
		t.Fatalf("grants: %+v", saved.Settings.Devices)
	}
	if saved.HomeDeviceID != original.HomeDeviceID || saved.WorkspaceID != original.WorkspaceID || saved.Settings.PreferredDeviceID != "dev_old" || !reflect.DeepEqual(saved.Settings.RunDefault, original.Settings.RunDefault) {
		t.Fatal("removed location silently moved")
	}
	got, err := db.GetKnowledgeVault(ctx, original.UserID, vault.ID)
	if err != nil || !reflect.DeepEqual(got, vault) {
		t.Fatalf("knowledge root changed: %+v %v", got, err)
	}
	if _, err = db.SavePersonalAgentSettings(ctx, original.UserID, original.Settings); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("stale grant accepted: %v", err)
	}
	saved.Settings.AssistantName = "Still editable"
	if _, err = db.SavePersonalAgentSettings(ctx, original.UserID, saved.Settings); err != nil {
		t.Fatalf("unchanged invalid reference blocked other preferences: %v", err)
	}
	if _, err = db.MovePersonalAgentHome(ctx, original.UserID, "ws_old", "dev_old"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("moved to removed: %v", err)
	}
	// Simulate a pre-fix row; the regular startup repair is scoped and idempotent.
	raw, _ := json.Marshal(original.Settings)
	if _, err = db.conn().ExecContext(ctx, `UPDATE personal_agents SET settings_json=? WHERE user_id=?`, string(raw), original.UserID); err != nil {
		t.Fatal(err)
	}
	if err = db.PurgeRemovedDevicesState(ctx); err != nil {
		t.Fatal(err)
	}
	repaired, _ := db.GetPersonalAgent(ctx, original.UserID)
	if len(repaired.Settings.Devices) != 1 || repaired.Settings.Devices[0].DeviceID != "dev_active" {
		t.Fatal("old authorization survived repair")
	}
	if err = db.PurgeRemovedDevicesState(ctx); err != nil {
		t.Fatal(err)
	}
	again, _ := db.GetPersonalAgent(ctx, original.UserID)
	if !reflect.DeepEqual(again, repaired) {
		t.Fatal("repair not idempotent")
	}
	if _, err = db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceLifecycleLateWritesAndSameNameOffline(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	agent := lifecycleAssistant(t, db)
	for _, id := range []string{"dev_old", "dev_active"} {
		if _, err := db.RenameDevice(ctx, id, "Same name"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.MarkAllDevicesOffline(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
	candidates, err := store.DeviceCandidates(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range candidates {
		if d.ID == "dev_old" {
			t.Fatal("removed candidate")
		}
		if d.ID == "dev_active" {
			found = true
			if d.Status != "disconnected" {
				t.Fatal(d)
			}
		}
	}
	if !found {
		t.Fatal("same name offline device lost")
	}
	for name, action := range map[string]func() error{
		"connector state": func() error {
			return db.SaveDeviceConnectorState(ctx, store.DeviceConnectorState{DeviceID: "dev_old", Kind: "bytedcli"})
		},
		"connector binding": func() error {
			return db.SetWorkspaceDeviceConnectors(ctx, "ws_active", agent.UserID, []store.DeviceConnectorBindingInput{{DeviceID: "dev_old", Kind: "bytedcli"}})
		},
		"inventory": func() error {
			return db.ReplaceSourceResources(ctx, store.ResourceSourceStatus{ID: "dev_old", Kind: "device"}, nil)
		},
		"lease": func() error {
			return db.SaveResourceLeaseChanges(ctx, store.ResourceLeaseChanges{Leases: []store.ResourceLease{{ID: "late", ResourceID: "res", SourceID: "dev_old", State: store.LeaseActive}}})
		},
		"rename": func() error { _, err := db.RenameDevice(ctx, "dev_old", "resurrect"); return err },
		"labels": func() error { return db.SetDeviceLabels(ctx, "dev_old", nil, agent.UserID) },
		"memory": func() error {
			_, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "late", UserID: agent.UserID, Kind: "memory", DeviceID: "dev_old", WorkspaceID: "ws_old", RootPath: "knowledge"})
			return err
		},
		"snapshot": func() error {
			_, err := db.RecordPersonalAgentRunSnapshot(ctx, store.PersonalAgentRunSnapshot{ID: "late", UserID: agent.UserID, DeviceID: "dev_old", WorkspaceID: "ws_old", ConfigHash: "fixed"})
			return err
		},
		"service": func() error {
			_, err := db.SaveSessionWork(ctx, store.SessionWork{ID: "late", ThreadID: "thread", SessionID: "session", DeviceID: "dev_old", Source: "foundry", Kind: "process", DesiredState: "enabled"})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := action(); !errors.Is(err, store.ErrDeviceRemoved) {
				t.Fatalf("late write: %v", err)
			}
		})
	}
}

func TestDeviceLifecycleRemovalRacesGrantAndLease(t *testing.T) {
	for _, kind := range []string{"settings", "lease"} {
		t.Run(kind, func(t *testing.T) {
			db, ctx := newTestStore(t), context.Background()
			agent := lifecycleAssistant(t, db)
			var removed, write error
			start := make(chan struct{})
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); <-start; _, removed = db.SoftRemoveDevice(ctx, "dev_old") }()
			go func() {
				defer wg.Done()
				<-start
				if kind == "settings" {
					_, write = db.SavePersonalAgentSettings(ctx, agent.UserID, agent.Settings)
				} else {
					write = db.SaveResourceLeaseChanges(ctx, store.ResourceLeaseChanges{Leases: []store.ResourceLease{{ID: "race", ResourceID: "res", SourceID: "dev_old", State: store.LeaseActive}}})
				}
			}()
			close(start)
			wg.Wait()
			if removed == nil {
				if write != nil && !errors.Is(write, store.ErrDeviceRemoved) {
					t.Fatal(write)
				}
				saved, _ := db.GetPersonalAgent(ctx, agent.UserID)
				if len(saved.Settings.Devices) != 1 || saved.Settings.Devices[0].DeviceID != "dev_active" {
					t.Fatal("grant survived removal")
				}
				leases, _ := db.ListResourceLeases(ctx, store.ResourceLeaseFilter{})
				for _, lease := range leases {
					if store.LeaseLive(lease.State) {
						t.Fatal("lease survived removal")
					}
				}
			} else if kind != "lease" || !errors.Is(removed, store.ErrDeviceBusy) || write != nil {
				t.Fatalf("remove=%v write=%v", removed, write)
			}
		})
	}
}

func TestDeviceLifecycleServiceBusyRequiresReceipt(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	lifecycleAssistant(t, db)
	item, err := db.SaveSessionWork(ctx, store.SessionWork{ID: "service", SessionID: "session", ThreadID: "thread", DeviceID: "dev_old", Source: "foundry", Kind: "process", Management: "managed", DesiredState: "enabled", Observation: store.WorkObservation{Status: "running"}, AllowedActions: []string{"stop", "resume"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SoftRemoveDevice(ctx, "dev_old"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("active service removal: %v", err)
	}
	item.DesiredState = "stopped"
	item.Revision++
	if err = db.withTx(ctx, func(tx *Store) error { return tx.writeWork(ctx, item) }); err != nil {
		t.Fatal(err)
	}
	if _, err = db.SoftRemoveDevice(ctx, "dev_old"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("stop intent treated as receipt: %v", err)
	}
	if err = db.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "stopped", ConfirmedRevision: item.Revision, At: time.Now().UTC().Format(time.RFC3339Nano), EndedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ControlSessionWork(ctx, item.ThreadID, item.SessionID, store.WorkControlInput{ID: item.ID, Action: "resume", ExpectedRevision: item.Revision, IdempotencyKey: "resume-removed"}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("resumed removed service: %v", err)
	}
}

func TestDeviceLifecycleLeaseBusyAndHistory(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	lifecycleAssistant(t, db)
	lease := store.ResourceLease{ID: "lease", ResourceID: "resource", SourceID: "dev_old", State: store.LeaseActive}
	if err := db.SaveResourceLeaseChanges(ctx, store.ResourceLeaseChanges{Leases: []store.ResourceLease{lease}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_old"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("active resource removal: %v", err)
	}
	lease.State = store.LeaseReleased
	lease.EndReason = "test completed"
	if err := db.SaveResourceLeaseChanges(ctx, store.ResourceLeaseChanges{Leases: []store.ResourceLease{lease}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
	leases, err := db.ListResourceLeases(ctx, store.ResourceLeaseFilter{})
	if err != nil || len(leases) != 1 || leases[0].EndReason != lease.EndReason {
		t.Fatalf("lease history lost: %+v %v", leases, err)
	}
}

func TestDeviceLifecycleConnectorBindingCleanup(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	agent := lifecycleAssistant(t, db)
	bindings := []store.DeviceConnectorBindingInput{{DeviceID: "dev_old", Kind: "bytedcli"}, {DeviceID: "dev_active", Kind: "bytedcli"}}
	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws_active", agent.UserID, bindings); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_old"); err != nil {
		t.Fatal(err)
	}
	remaining, err := db.ListWorkspaceDeviceConnectors(ctx, "ws_active")
	if err != nil || len(remaining) != 1 || remaining[0].DeviceID != "dev_active" {
		t.Fatalf("binding cleanup %+v %v", remaining, err)
	}
	if err := db.SetWorkspaceDeviceConnectors(ctx, "ws_active", agent.UserID, bindings[1:]); err != nil {
		t.Fatalf("active binding blocked: %v", err)
	}
}
