package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Only a device's owner sets its labels, they are normalized, and the
// list answers the caller's own devices with what was detected.
func TestDeviceLabelsAreTheOwnersToSet(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	if err := f.server.store.SaveDeviceConnectorState(ctx, store.DeviceConnectorState{
		DeviceID: "dev_alice", Kind: "bytedcli", Status: store.DeviceConnectorSignedOut, Installed: true,
	}); err != nil {
		t.Fatal(err)
	}
	put := func(cookie, deviceID, body string) int {
		return doAuthCall(t, f.handler, f.as(cookie, http.MethodPut, "/api/devices/"+deviceID+"/labels", body)).Code
	}
	saved := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut, "/api/devices/dev_alice/labels",
		`{"labels":[{"key":" Network ","value":"Corp"},{"key":"gpu"},{"key":"network","value":"corp"}]}`))
	expectStatus(t, saved, http.StatusOK, "alice labels her device")
	var placement store.DevicePlacement
	if err := json.Unmarshal(saved.Body.Bytes(), &placement); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(placement.Labels, []store.DeviceLabel{{Key: "network", Value: "corp"}, {Key: "gpu"}}) {
		t.Fatalf("labels = %+v", placement.Labels)
	}
	if !slices.ContainsFunc(placement.Facts, func(fact store.DeviceFact) bool {
		return fact.Key == "reaches" && fact.Value == "cloud.bytedance.net" && fact.Source == "connector"
	}) {
		t.Fatalf("facts = %+v: bytedcli's network check passed there", placement.Facts)
	}
	if code := put(f.alice, "dev_alice", `{"labels":[{"key":"has space"}]}`); code != http.StatusBadRequest {
		t.Fatalf("a malformed label: %d", code)
	}
	if code := put(f.bob, "dev_alice", `{"labels":[]}`); code != http.StatusNotFound {
		t.Fatalf("bob labels alice's device: %d", code)
	}
	list := func(cookie string) []store.DevicePlacement {
		recorder := doAuthCall(t, f.handler, f.as(cookie, http.MethodGet, "/api/device-placements", ""))
		expectStatus(t, recorder, http.StatusOK, "list placements")
		var placements []store.DevicePlacement
		_ = json.Unmarshal(recorder.Body.Bytes(), &placements)
		return placements
	}
	if mine := list(f.alice); len(mine) != 1 || mine[0].DeviceID != "dev_alice" || len(mine[0].Labels) != 2 {
		t.Fatalf("alice's placements = %+v", mine)
	}
	if bobs := list(f.bob); len(bobs) != 1 || bobs[0].DeviceID != "dev_bob" {
		t.Fatalf("bob's placements = %+v", bobs)
	}
}

// placementFixture: alice's assistant beside a second computer of hers,
// her work laptop, labelled as on the company network and allowed to hold
// new projects.
func placementFixture(t *testing.T) assistantFixture {
	t.Helper()
	f := newAssistantFixture(t)
	ctx, db := context.Background(), f.server.store
	_, work := pairOverHTTP(t, f.handler, f.alice, "machine-alice-work", "dev_alice_work")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register",
		strings.Replace(registrationBody("dev_alice_work", "ws_work"), `"label":"Device"`, `"label":"Work laptop"`, 1), work)),
		http.StatusOK, "register the work laptop")
	if err := db.SetDeviceLabels(ctx, "dev_alice_work", []store.DeviceLabel{{Key: "network", Value: "corp"}}, f.aliceID); err != nil {
		t.Fatal(err)
	}
	agent, err := db.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.Devices = []store.PersonalAgentDeviceSettings{
		{DeviceID: "dev_alice", AllowWork: true, AllowCreate: true},
		{DeviceID: "dev_alice_work", AllowWork: true, AllowCreate: true},
	}
	if _, err := db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f assistantFixture) create(t *testing.T, needs ...string) (map[string]json.RawMessage, string) {
	t.Helper()
	text, failed := f.tool(t, f.token, "create_workspace", map[string]any{
		"name": "Project " + strings.Join(needs, " "), "purpose": "x", "source": map[string]any{"kind": "empty"}, "needs": needs,
	})
	if failed {
		t.Fatalf("create_workspace %v failed: %s", needs, text)
	}
	var answer map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		t.Fatalf("create_workspace answered %s", text)
	}
	return answer, text
}

func TestNewProjectsGoWhereWhatTheyNeedIs(t *testing.T) {
	f := placementFixture(t)

	answer, text := f.create(t, "network:corp")
	if last := f.lifecycle.creates[len(f.lifecycle.creates)-1]; last.DeviceID != "dev_alice_work" {
		t.Fatalf("work needing the company network went to %s: %s", last.DeviceID, text)
	}
	var place store.PersonalAgentPlacement
	if err := json.Unmarshal(answer["place"], &place); err != nil || place.Computer != "Work laptop" || place.Reason == "" {
		t.Fatalf("the answer does not say where it went: %s", text)
	}

	f.create(t)
	if last := f.lifecycle.creates[len(f.lifecycle.creates)-1]; last.DeviceID != "dev_alice" {
		t.Fatalf("self-contained work went to %s, not the default place (home)", last.DeviceID)
	}

	answer, text = f.create(t, "toolchain:xcode")
	var missing []string
	_ = json.Unmarshal(answer["missing"], &missing)
	if string(answer["status"]) != `"no_place_fits"` || !slices.Equal(missing, []string{"toolchain:xcode"}) {
		t.Fatalf("nothing has Xcode, yet: %s", text)
	}
	if len(f.lifecycle.creates) != 2 {
		t.Fatalf("no place fits, yet a project was created: %v", f.lifecycle.calls)
	}
	if action := f.lastAction(t); action.Outcome != store.PersonalAgentOutcomeRefused || action.Refusal != store.PersonalAgentRefusalNoPlace {
		t.Fatalf("audit = %+v", action)
	}

	// The default place is the person's to choose.
	ctx := context.Background()
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.PreferredDeviceID = "dev_alice_work"
	if _, err := f.server.store.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	f.create(t)
	if last := f.lifecycle.creates[len(f.lifecycle.creates)-1]; last.DeviceID != "dev_alice_work" {
		t.Fatalf("self-contained work went to %s, not the chosen default place", last.DeviceID)
	}
}

// A computer the settings do not open for new projects is never chosen;
// the answer says it has what is needed but may not be used. One whose
// system account someone else's device shares is used only as the person
// chose it ("can start new projects here", or their default place), never
// through a default, and the answer says it is shared.
func TestPlacementUsesSharedComputersOnlyAsChosen(t *testing.T) {
	f := placementFixture(t)
	ctx, db := context.Background(), f.server.store
	identity := store.DeviceAccountIdentity{OSAccountFingerprint: "shared-account", HostFingerprint: "host"}
	for _, device := range []string{"dev_alice_work", "dev_bob"} {
		if _, err := db.RecordDeviceAccountIdentity(ctx, device, identity); err != nil {
			t.Fatal(err)
		}
	}
	// The person allowed new projects on the work laptop.
	answer, text := f.create(t, "network:corp")
	if last := f.lifecycle.creates[len(f.lifecycle.creates)-1]; last.DeviceID != "dev_alice_work" {
		t.Fatalf("work needing the company network went to %s: %s", last.DeviceID, text)
	}
	var place store.PersonalAgentPlacement
	if err := json.Unmarshal(answer["place"], &place); err != nil || !strings.Contains(place.Reason, "system account is shared with") {
		t.Fatalf("the answer does not say the computer is shared: %s", text)
	}

	agent, _ := db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Devices[1].AllowCreate = false
	if _, err := db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	answer, text = f.create(t, "network:corp")
	if string(answer["status"]) != `"no_place_fits"` || !strings.Contains(text, "settings do not let you") || !strings.Contains(text, "only the person can choose it") {
		t.Fatalf("a shared computer closed to new projects was not refused: %s", text)
	}

	// "Can work on this computer" is on by default, so it never opens a
	// shared computer to the person's folders; their default place does.
	register := func() (string, bool) {
		return f.tool(t, f.token, "create_workspace", map[string]any{
			"name": "Old notes", "purpose": "x", "deviceId": "dev_alice_work",
			"source": map[string]any{"kind": "existing", "path": "/home/alice/notes"},
		})
	}
	if text, failed := register(); !failed || !strings.Contains(text, "not allowed") {
		t.Fatalf("an existing folder on a shared computer nobody chose: %s", text)
	}
	agent.Settings.PreferredDeviceID = "dev_alice_work"
	if _, err := db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	if text, failed := register(); failed {
		t.Fatalf("the person's default place was refused: %s", text)
	}
	if len(f.lifecycle.creates) != 1 {
		t.Fatalf("created: %v", f.lifecycle.calls)
	}
}

// The assistant's snapshot lists each computer's labels and detected
// facts in the words it passes as needs.
func TestAssistantSnapshotShowsWhatComputersHave(t *testing.T) {
	f := placementFixture(t)
	agent, err := f.server.store.GetPersonalAgent(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	input, err := f.server.assistantPromptInput(context.Background(), agent, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if text := prompt.Fill(input); !strings.Contains(text, `"Work laptop" [dev_alice_work]:`) || !strings.Contains(text, "the person says it has network:corp") {
		t.Fatalf("the snapshot does not show the work laptop's labels:\n%s", text)
	}
}

// Detected resources become facts: a toolchain by id, a GPU by vendor (or
// none), nothing for a resource that is not ready.
func TestResourceFacts(t *testing.T) {
	ready := store.ResourceReadiness{Ready: true, Level: "installed"}
	cases := []struct {
		instance store.ResourceInstance
		want     store.DeviceFact
		ok       bool
	}{
		{store.ResourceInstance{Type: "toolchain", Key: "toolchain/go", Name: "Go 1.23", Readiness: ready},
			store.DeviceFact{Key: "toolchain", Value: "go", Detail: "Go 1.23", Source: "toolchain"}, true},
		{store.ResourceInstance{Type: "gpu", Key: "gpu/nvidia/x", Name: "RTX 4090", Readiness: ready, Details: map[string]string{"vendor": "NVIDIA"}},
			store.DeviceFact{Key: "gpu", Value: "nvidia", Detail: "RTX 4090", Source: "gpu"}, true},
		{store.ResourceInstance{Type: "gpu", Key: "gpu/macos/0", Name: "Apple M3", Readiness: ready},
			store.DeviceFact{Key: "gpu", Detail: "Apple M3", Source: "gpu"}, true},
		{store.ResourceInstance{Type: "gpu", Key: "gpu/nvidia", Readiness: store.ResourceReadiness{}}, store.DeviceFact{}, false},
		{store.ResourceInstance{Type: "browser", Key: "browser/chrome", Readiness: ready}, store.DeviceFact{}, false},
	}
	for _, tc := range cases {
		if got, ok := resourceFact(tc.instance); ok != tc.ok || got != tc.want {
			t.Errorf("resourceFact(%s) = %+v, %v; want %+v, %v", tc.instance.Key, got, ok, tc.want, tc.ok)
		}
	}
}
