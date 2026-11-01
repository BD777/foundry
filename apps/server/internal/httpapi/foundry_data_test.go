package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// everyFoundryDataField selects every field foundry-data has.
func everyFoundryDataField() fieldSet {
	want := fieldSet{}
	for _, name := range foundryDataFields {
		want[name] = true
	}
	return want
}

func foundryDataForTest(t *testing.T, server *Server, query string, header http.Header) (*httptest.ResponseRecorder, map[string]json.RawMessage) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/foundry-data"+query, nil)
	for name, values := range header {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	fields := map[string]json.RawMessage{}
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
			t.Fatalf("decode foundry-data: %v", err)
		}
	}
	return response, fields
}

func fieldNamesForTest(fields map[string]json.RawMessage) []string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// A read without ?fields= answers what the always-on views read: not the
// library's catalog (the Skills pages select it) or the unread skills; the
// composer's menu gets the workspace's skills, and the skills agents ship
// come only with the workspace device's rows.
func TestFoundryDataDefaultLeavesPageFieldsOut(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_fields")
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_ws_fields", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_fields", Name: "Workspace", LocalPath: t.TempDir()},
		ProviderHealth: []store.ProviderHealth{{Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			OfficialSkills: []store.OfficialSkill{{Name: "dataviz", Description: "Charts"}}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_elsewhere", Label: "Elsewhere", Status: "connected", LastSeenLabel: "online"},
		ProviderHealth: []store.ProviderHealth{{Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			OfficialSkills: []store.OfficialSkill{{Name: "pptx", Description: "Slides"}}}},
	}); err != nil {
		t.Fatal(err)
	}
	add := func(name, description string) store.PromotedSkill {
		t.Helper()
		archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: " + name + "\n---\n"})
		skill, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "dev_ws_fields", Root: "/skills", DirName: name}, name, description, archive, 1)
		if err != nil {
			t.Fatal(err)
		}
		return skill
	}
	selected := add("review", "Reviews a change")
	add("notes", "Takes notes")
	if err := db.SetWorkspaceSkills(ctx, store.SetWorkspaceSkillsInput{WorkspaceID: "ws_fields", SkillIDs: []string{selected.ID}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)

	_, fields := foundryDataForTest(t, server, "?workspaceId=ws_fields", nil)
	for _, left := range []string{fieldPromotedSkills, fieldSkills} {
		if _, ok := fields[left]; ok {
			t.Errorf("the default read carries %s", left)
		}
	}
	for _, kept := range []string{fieldWorkspace, fieldWorkspaces, fieldDevices, fieldProviderHealth, fieldAgentProfiles, fieldAgents,
		fieldAgentSessions, fieldIssues, fieldChats, fieldAssets, fieldWorkspaceFiles, fieldWorkspaceSkillBindings, fieldDeviceSkillRoots, fieldProfiles, fieldDeviceProfiles} {
		if _, ok := fields[kept]; !ok {
			t.Errorf("the default read lacks %s: %v", kept, fieldNamesForTest(fields))
		}
	}
	var menu []workspaceSkillSummary
	_ = json.Unmarshal(fields[fieldWorkspaceSkills], &menu)
	if !reflect.DeepEqual(menu, []workspaceSkillSummary{{ID: selected.ID, Name: "review", Description: "Reviews a change"}}) {
		t.Fatalf("workspaceSkills = %+v, want the selected skill with its description", menu)
	}
	var health []store.ProviderHealth
	_ = json.Unmarshal(fields[fieldProviderHealth], &health)
	official := map[string]int{}
	for _, row := range health {
		official[row.DeviceID] = len(row.OfficialSkills)
	}
	if _, listed := official["dev_elsewhere"]; official["dev_ws_fields"] != 1 || official["dev_elsewhere"] != 0 || !listed {
		t.Fatalf("official skills per device = %v, want only the workspace device's", official)
	}

	_, catalog := foundryDataForTest(t, server, "?workspaceId=ws_fields&fields=promotedSkills", nil)
	if names := fieldNamesForTest(catalog); !reflect.DeepEqual(names, []string{fieldPromotedSkills, fieldWorkspace}) {
		t.Fatalf("fields=promotedSkills answered %v", names)
	}
	var promoted []store.PromotedSkill
	_ = json.Unmarshal(catalog[fieldPromotedSkills], &promoted)
	if len(promoted) != 2 {
		t.Fatalf("catalog = %d skills, want 2", len(promoted))
	}
}

// A selection answers the workspace and the fields named, with its own
// ETag; an unknown field is refused.
func TestFoundryDataSelectionsHaveTheirOwnETag(t *testing.T) {
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_select")
	server := NewServer(db)
	response, fields := foundryDataForTest(t, server, "?workspaceId=ws_select&fields=chats,agentSessions", nil)
	if names := fieldNamesForTest(fields); !reflect.DeepEqual(names, []string{fieldAgentSessions, fieldChats, fieldWorkspace}) {
		t.Fatalf("selection answered %v", names)
	}
	tag := response.Header().Get("ETag")
	again, _ := foundryDataForTest(t, server, "?workspaceId=ws_select&fields=agentSessions,chats", http.Header{"If-None-Match": {"W/" + tag}})
	if again.Code != http.StatusNotModified {
		t.Fatalf("the same selection with its weak ETag = %d, want 304", again.Code)
	}
	other, _ := foundryDataForTest(t, server, "?workspaceId=ws_select&fields=chats", http.Header{"If-None-Match": {tag}})
	if other.Code != http.StatusOK || other.Header().Get("ETag") == tag {
		t.Fatalf("another selection = %d with ETag %s", other.Code, other.Header().Get("ETag"))
	}
	if refused, _ := foundryDataForTest(t, server, "?workspaceId=ws_select&fields=chats,secrets", nil); refused.Code != http.StatusBadRequest {
		t.Fatalf("an unknown field = %d, want 400", refused.Code)
	}
}

// A list summary leaves out an opening prompt its input repeats.
func TestFoundryDataSessionsDropRepeatedPrompts(t *testing.T) {
	sessions := withoutRepeatedPrompts([]store.AgentSession{
		{ID: "one", Prompt: "Fix it", Input: store.SessionInput{Prompt: "Fix it"}},
		{ID: "two", Prompt: "Fix it", Input: store.SessionInput{Prompt: "And test it"}},
	})
	if sessions[0].Prompt != "" || sessions[1].Prompt != "Fix it" {
		t.Fatalf("prompts = %q, %q", sessions[0].Prompt, sessions[1].Prompt)
	}
}

// dataChangeResourcesForTest keeps each foundry_data_changed event as
// "workspace: field,field" ("*" when it names none).
func dataChangeResourcesForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	found := []string{}
	for _, event := range events {
		if event.kind != browserevent.FoundryDataChanged {
			continue
		}
		var payload browserevent.FoundryDataChangedPayload
		if err := json.Unmarshal(event.payload, &payload); err != nil {
			t.Fatal(err)
		}
		resources := "*"
		if len(payload.Resources) > 0 {
			resources = strings.Join(payload.Resources, ",")
		}
		found = append(found, payload.WorkspaceID+": "+resources)
	}
	return found
}

// A burst's trailing announcement names every field its changes touched;
// a change naming none makes it name none.
func TestDataChangesNameTheFieldsTheyTouched(t *testing.T) {
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 100 * time.Millisecond
	defer func() { foundryDataChangeInterval = interval }()
	events := newNotifiersForTest(nil)
	viewer := subscribeForTest(events.stream)
	events.data.changed("ws_a", fieldIssues)
	events.data.changed("ws_a", fieldChats)
	events.data.changed("ws_a", fieldAgentSessions, fieldChats)
	events.data.changed("ws_b", fieldDevices)
	events.data.changed("ws_b")
	if got := dataChangeResourcesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_a: issues", "ws_b: devices"}) {
		t.Fatalf("first of the bursts = %v", got)
	}
	time.Sleep(250 * time.Millisecond)
	got := dataChangeResourcesForTest(t, drainForTest(t, viewer))
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"ws_a: agentSessions,chats", "ws_b: *"}) {
		t.Fatalf("trailing announcements = %v", got)
	}
}

// chatsChangesForTest keeps chats_changed events as
// "workspace +id,id -id".
func chatsChangesForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	found := []string{}
	for _, event := range events {
		if event.kind != browserevent.ChatsChanged {
			continue
		}
		var payload browserevent.ChatsChangedPayload
		if err := json.Unmarshal(event.payload, &payload); err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, chat := range payload.Chats {
			if chat.Transcript != nil || chat.RecentMessages != nil || chat.HandoffContext != "" {
				t.Fatalf("pushed chat %s carries what the list leaves out: %s", chat.ID, event.payload)
			}
			ids = append(ids, chat.ID)
		}
		found = append(found, payload.WorkspaceID+" +"+strings.Join(ids, ",")+" -"+strings.Join(payload.Removed, ","))
	}
	return found
}

// A device's chat sync sends viewers the chats it changed as the list shows
// them, instead of announcing a read; a sync changing only what the list
// leaves out, or nothing, sends nothing; a chat the list stops showing is
// sent as removed, once.
func TestChatSyncPushesTheChangedChats(t *testing.T) {
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_push")
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	sync := func(body string, want []string, why string) {
		t.Helper()
		requestForTest(t, server, http.MethodPost, "/api/daemon/chats/sync", body, http.StatusOK)
		events := drainForTest(t, viewer)
		if got := dataChangesForTest(t, events); len(got) != 0 {
			t.Fatalf("%s: announced a read for %v", why, got)
		}
		if got := chatsChangesForTest(t, events); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: pushed %v, want %v", why, got, want)
		}
	}
	chat := func(title, recent string) string {
		return `{"workspaceId":"ws_push","chats":[{"id":"chat_1","provider":"codex","nativeSessionId":"nat_1","title":"` + title +
			`","preview":"","readonly":false,"recentMessages":[{"role":"user","text":"` + recent + `"}]}]}`
	}
	sync(chat("First", "hi"), []string{"ws_push +chat_1 -"}, "a new chat")
	sync(chat("First", "hi"), []string{}, "the same chat")
	sync(chat("First", "hello"), []string{}, "only recent messages changed")
	sync(chat("Second", "hello"), []string{"ws_push +chat_1 -"}, "a renamed chat")
	sync(`{"workspaceId":"ws_push","chats":[]}`, []string{}, "an empty sync")
	// Without turns a native chat is removed from the list.
	empty := `{"workspaceId":"ws_push","chats":[{"id":"chat_1","provider":"codex","nativeSessionId":"nat_1","title":"Second","preview":"","readonly":false,"transcript":[]}]}`
	sync(empty, []string{"ws_push + -chat_1"}, "a chat the list stops showing")
	sync(empty, []string{}, "the removal again")
}

// A registration names what it changed: the device's parts for every
// view, the workspace's parts for that workspace.
func TestRegistrationNamesTheFieldsItChanged(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	register := func(health, asset string, want []string, why string) {
		t.Helper()
		body := `{"device":{"id":"dev_reg","label":"Device","status":"connected","lastSeenLabel":"online"},` +
			`"workspace":{"id":"ws_reg","name":"Workspace","localPath":"/tmp/ws_reg"},` +
			`"assets":[{"id":"asset_1","workspaceId":"ws_reg","name":"` + asset + `","kind":"artifact_archive","status":"available","detail":""}],` +
			`"providerHealth":[{"provider":"codex","status":"` + health + `","authMode":"local_config","secretStored":"local"}]}`
		requestForTest(t, server, http.MethodPost, "/api/daemon/register", body, http.StatusOK)
		got := dataChangeResourcesForTest(t, drainForTest(t, viewer))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: announced %v, want %v", why, got, want)
		}
	}
	register("healthy", "Archive", []string{": agentProfiles,agents,deviceSkillRoots,devices,promotedSkills,providerHealth,workspaces", "ws_reg: assets,workspaces"}, "a new device and workspace")
	register("healthy", "Archive", []string{}, "the same registration")
	register("unavailable", "Archive", []string{": agentProfiles,agents,providerHealth"}, "provider health")
	register("unavailable", "Renamed", []string{"ws_reg: assets"}, "an asset")
}

// chatsGateStore answers the first chats read as the store has them, then
// holds that answer until released: a sync that read before an adoption.
type chatsGateStore struct {
	*sqlitestore.Store
	gate  chan struct{}
	reads atomic.Int32
}

func (s *chatsGateStore) ListChatsByID(ctx context.Context, workspaceID string, ids []string) ([]store.ChatThread, error) {
	listed, err := s.Store.ListChatsByID(ctx, workspaceID, ids)
	if s.reads.Add(1) == 1 {
		<-s.gate
	}
	return listed, err
}

// A push reads and publishes before the next one reads: a sync that read a
// chat as listed cannot publish it after an adoption published its removal.
func TestChatPushesPublishInTheOrderTheyRead(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_order")
	chat := func(transcript string) store.SyncChatsInput {
		var input store.SyncChatsInput
		if err := json.Unmarshal([]byte(`{"workspaceId":"ws_order","chats":[{"id":"chat_1","provider":"codex","nativeSessionId":"nat_1","title":"Native","preview":"","readonly":false,`+transcript+`}]}`), &input); err != nil {
			t.Fatal(err)
		}
		return input
	}
	if _, err := db.SyncChatsChanges(ctx, chat(`"recentMessages":[{"role":"user","text":"hi"}]`)); err != nil {
		t.Fatal(err)
	}
	gated := &chatsGateStore{Store: db, gate: make(chan struct{})}
	events := newNotifiersForTest(gated)
	viewer := subscribeForTest(events.stream)
	synced := make(chan struct{})
	go func() {
		events.chatList.chatsChanged(ctx, "ws_order", []string{"chat_1"})
		close(synced)
	}()
	time.Sleep(50 * time.Millisecond)
	// The chat leaves the list (here: a sync without turns), and that change
	// pushes too, while the first push still holds what it read.
	if _, err := db.SyncChatsChanges(ctx, chat(`"transcript":[]`)); err != nil {
		t.Fatal(err)
	}
	removed := make(chan struct{})
	go func() {
		events.chatList.chatsChanged(ctx, "ws_order", []string{"chat_1"})
		close(removed)
	}()
	time.Sleep(50 * time.Millisecond)
	close(gated.gate)
	<-synced
	<-removed
	if got := chatsChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_order +chat_1 -", "ws_order + -chat_1"}) {
		t.Fatalf("pushes = %v, want the listed chat, then its removal", got)
	}
}

// A device's skill scan announces what it changes, the catalog's
// dependency information included.
func TestDeviceSkillScanAnnouncesTheCatalog(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	hub := fixture.server.hub
	connection := newDaemonConnection(hub, nil)
	connection.deviceID = fixture.deviceID
	hub.connections[fixture.deviceID] = connection
	defer close(connection.done)
	go func() {
		for envelope := range connection.send {
			if envelope.Type != wsScanSkillsType {
				continue
			}
			payload, _ := json.Marshal(wsSkillsScannedPayload{Skills: []store.DeviceSkill{{Name: "notes", Root: "~/.claude/skills", DirName: "notes"}}})
			_ = deliverDaemonResponse[wsSkillsScannedPayload](connection, wsEnvelope{ID: envelope.ID, Type: wsSkillsScannedType, Payload: payload}, nil)
		}
	}()
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	viewer := subscribeForTest(fixture.server.stream)
	requestForTest(t, fixture.server, http.MethodPost, "/api/device-skills/scan?deviceId="+fixture.deviceID, "", http.StatusOK)
	if got := dataChangeResourcesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{": deviceTools,devices,promotedSkills"}) {
		t.Fatalf("a scan announced %v", got)
	}
}

// Before there is a workspace, the catalog and the devices' scan folders
// are still read, and no list answers null.
func TestFoundryDataWithoutAWorkspaceAnswersLists(t *testing.T) {
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_alone", Label: "Alone", Status: "connected", LastSeenLabel: "online"},
	}); err != nil {
		t.Fatal(err)
	}
	archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: notes\n---\n"})
	if _, _, err := db.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{DeviceID: "dev_alone", Root: "/skills", DirName: "notes"}, "notes", "Takes notes", archive, 1); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	_, fields := foundryDataForTest(t, server, "?fields=promotedSkills,deviceSkillRoots,workspaceSkillBindings", nil)
	var workspace store.WorkspaceProjection
	_ = json.Unmarshal(fields[fieldWorkspace], &workspace)
	if workspace.ID != "" {
		t.Fatalf("workspace = %q, want none", workspace.ID)
	}
	for _, name := range []string{fieldPromotedSkills, fieldDeviceSkillRoots, fieldWorkspaceSkillBindings} {
		if raw := strings.TrimSpace(string(fields[name])); !strings.HasPrefix(raw, "[") {
			t.Errorf("%s = %s, want a list", name, raw)
		}
	}
	var catalog []store.PromotedSkill
	var roots []store.DeviceSkillRoot
	_ = json.Unmarshal(fields[fieldPromotedSkills], &catalog)
	_ = json.Unmarshal(fields[fieldDeviceSkillRoots], &roots)
	if len(catalog) != 1 || len(roots) == 0 {
		t.Fatalf("catalog %d skills, %d scan folders; want the skill and the device's default folders", len(catalog), len(roots))
	}
}
