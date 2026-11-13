package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Two sessions lease one device's compute at once when its worker runs
// shared leases: each works in its own scratch folder unless it names one,
// their requests say shared, an exclusive request is refused while they
// hold it, and the owner's slots setting changes only what it names.
func TestComputeLeasesShareTheDeviceWhenItsWorkerCan(t *testing.T) {
	f := newReachFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	type agent struct{ id, token string }
	session := func() agent {
		created, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "check",
		})
		if err != nil {
			t.Fatal(err)
		}
		token, err := f.db.MintAgentSessionToken(ctx, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		return agent{created.ID, token}
	}
	first, second, third := session(), session(), session()
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities":     []string{store.DaemonCapabilitySharedLeases},
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_alice", "label": "Alice's Mac", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/ws_alice"},
	}, map[string]fakeAnswer{
		wsResourceSettingsType: func(payload json.RawMessage) (string, any) {
			var settings store.ResourceSourceSettings
			_ = json.Unmarshal(payload, &settings)
			return wsResourceSettingsAppliedType, settings
		},
		wsResourceResetType: func(payload json.RawMessage) (string, any) {
			var request store.ResourceResetRequest
			_ = json.Unmarshal(payload, &request)
			return wsResourceResetDoneType, store.ResourceResetResult{ResourceID: request.ResourceID, Generation: request.Generation}
		},
		wsResourceOperateType: func(payload json.RawMessage) (string, any) {
			var request store.ResourceOperateRequest
			_ = json.Unmarshal(payload, &request)
			results := []store.ResourceActionResult{}
			for _, action := range request.Actions {
				results = append(results, store.ResourceActionResult{Op: action.Op, OK: true, Text: `{"exitCode":0}`})
			}
			return wsResourceOperatedType, store.ResourceOperateResult{Results: results}
		},
	})
	ready := store.ResourceReadiness{Ready: true, Level: "configured"}
	if _, err := f.server.resources.Report(ctx, store.ResourceSource{Kind: "device", ID: "dev_alice", Label: "Alice's Mac"}, store.ResourcesReport{
		Instances: []store.DetectedResource{{Key: "compute", Type: "compute", Platform: "macos", Name: "Compute (10 CPUs, 16 GiB)",
			Detector: "compute@1", Readiness: ready, Details: map[string]string{"cpus": "10", "memoryGiB": "16"},
			Backends: []store.ResourceBackend{{ID: "foundry-compute", Mode: "remote_ops", Readiness: ready}}}},
	}); err != nil {
		t.Fatal(err)
	}
	compute := resources.InstanceID("dev_alice", "compute")
	settingsPath := "/api/devices/dev_alice/resources/settings"
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"computeSlots":65}`)), http.StatusBadRequest, "too many slots")
	saved := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"computeSlots":2}`))
	expectStatus(t, saved, http.StatusOK, "alice sets two slots")
	if settings, err := f.server.resources.Settings(ctx, "dev_alice"); err != nil || !settings.AllowRemoteCommands || settings.ComputeSlots != 2 {
		t.Fatalf("settings after naming only the slots = %+v %v", settings, err)
	}

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"denyWorkspaces":["ws_other"]}`)), http.StatusOK, "alice denies another workspace")
	if settings, err := f.server.resources.Settings(ctx, "dev_alice"); err != nil || settings.ComputeSlots != 2 || len(settings.DenyWorkspaces) != 1 {
		t.Fatalf("settings after naming only the deny list = %+v %v", settings, err)
	}
	acquire := func(who agent, args map[string]any) (string, bool) {
		args["resourceId"] = compute
		content, isError := mcpContentCall(t, f.handler, who.token, "acquire_resource", args)
		return content[0]["text"].(string), isError
	}
	leaseOf := func(text string) resources.View {
		var acquired struct {
			Lease resources.View `json:"lease"`
		}
		_ = json.Unmarshal([]byte(text), &acquired)
		return acquired.Lease
	}
	text, isError := acquire(first, map[string]any{})
	firstLease := leaseOf(text)
	if isError || firstLease.Mode != store.LeaseShared {
		t.Fatalf("first shared lease = %s", text)
	}
	text, isError = acquire(second, map[string]any{})
	secondLease := leaseOf(text)
	if isError || secondLease.Mode != store.LeaseShared {
		t.Fatalf("second shared lease beside the first = %s", text)
	}
	if text, isError = acquire(third, map[string]any{"mode": "exclusive"}); !isError || !strings.Contains(text, `"code":"busy"`) {
		t.Fatalf("exclusive while two share it = %s", text)
	}
	for _, run := range []struct {
		who     agent
		lease   string
		scratch string
		args    map[string]any
	}{
		{first, firstLease.ID, first.id, map[string]any{"command": "ls"}},
		{second, secondLease.ID, "warm", map[string]any{"command": "ls", "scratch": "warm"}},
	} {
		content, isError := mcpContentCall(t, f.handler, run.who.token, "operate_resource", map[string]any{"leaseId": run.lease, "op": "run", "args": run.args})
		if isError {
			t.Fatalf("run = %v", content)
		}
		sent := device.received(wsResourceOperateType)
		var request store.ResourceOperateRequest
		_ = json.Unmarshal(sent[len(sent)-1], &request)
		if !request.Shared || request.LeaseID != run.lease || request.Actions[0].Args["scratch"] != run.scratch {
			t.Fatalf("operate request = %+v", request)
		}
	}
	listed, err := f.server.resources.List(ctx, store.ResourceFilter{Type: "compute"})
	if err != nil || len(listed.Instances) != 1 {
		t.Fatalf("list = %+v %v", listed, err)
	}
	instance := listed.Instances[0]
	if instance.Slots == nil || *instance.Slots != (store.ResourceSlots{Capacity: 2, InUse: 2}) || len(instance.Holders) != 2 {
		t.Fatalf("listed compute = slots %+v holders %+v", instance.Slots, instance.Holders)
	}
	released := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/resources/"+compute+"/release?leaseId="+firstLease.ID, ``))
	expectStatus(t, released, http.StatusOK, "alice ends one of the leases")
	if lease, err := f.server.leases.Lease(ctx, secondLease.ID); err != nil || lease.State != store.LeaseActive {
		t.Fatalf("the other lease after alice ended one = %+v %v", lease, err)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, settingsPath, `{"denyWorkspaces":["ws_alice"]}`)), http.StatusOK, "alice denies the sessions' workspace")
	if text, isError := acquire(third, map[string]any{}); !isError || !strings.Contains(text, "lease policy") {
		t.Fatalf("acquire from a denied workspace = %s", text)
	}
	if lease, err := f.server.leases.Lease(ctx, secondLease.ID); err != nil || lease.State != store.LeaseRevoked {
		t.Fatalf("a lease of a workspace denied afterwards = %+v %v", lease, err)
	}
}
