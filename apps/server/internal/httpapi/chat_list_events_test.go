package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

type streamedForTest struct {
	kind    browserevent.Type
	payload json.RawMessage
}

// drainForTest returns the events a subscriber holds, in order.
func drainForTest(t *testing.T, viewer *eventstream.Subscription) []streamedForTest {
	t.Helper()
	events := []streamedForTest{}
	for len(viewer.C) > 0 {
		events = append(events, decodeStreamedForTest(t, <-viewer.C))
	}
	return events
}

// chatListEventsForTest keeps the chat list events, as "type workspaceId".
// Their payload names the workspace and carries nothing but what changed.
func chatListEventsForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	found := []string{}
	for _, event := range events {
		if event.kind != browserevent.ChatTitlesChanged && event.kind != browserevent.ChatLayoutChanged {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(event.payload, &payload); err != nil || payload["workspaceId"] == nil {
			t.Fatalf("%s payload = %s, want {\"workspaceId\": …}", event.kind, event.payload)
		}
		allowed := map[string]bool{"workspaceId": true, "titles": event.kind == browserevent.ChatTitlesChanged,
			"removed": event.kind == browserevent.ChatTitlesChanged, "layout": event.kind == browserevent.ChatLayoutChanged}
		for key := range payload {
			if !allowed[key] {
				t.Fatalf("%s payload = %s: unexpected %q", event.kind, event.payload, key)
			}
		}
		found = append(found, string(event.kind)+" "+payload["workspaceId"].(string))
	}
	return found
}

// titlesChangesForTest decodes the chat_titles_changed payloads.
func titlesChangesForTest(t *testing.T, events []streamedForTest) []browserevent.ChatTitlesChangedPayload {
	t.Helper()
	found := []browserevent.ChatTitlesChangedPayload{}
	for _, event := range events {
		if event.kind != browserevent.ChatTitlesChanged {
			continue
		}
		var change browserevent.ChatTitlesChangedPayload
		if err := json.Unmarshal(event.payload, &change); err != nil {
			t.Fatal(err)
		}
		found = append(found, change)
	}
	return found
}

// layoutChangesForTest decodes the chat_layout_changed payloads.
func layoutChangesForTest(t *testing.T, events []streamedForTest) []browserevent.ChatLayoutChangedPayload {
	t.Helper()
	found := []browserevent.ChatLayoutChangedPayload{}
	for _, event := range events {
		if event.kind != browserevent.ChatLayoutChanged {
			continue
		}
		var change browserevent.ChatLayoutChangedPayload
		if err := json.Unmarshal(event.payload, &change); err != nil {
			t.Fatal(err)
		}
		found = append(found, change)
	}
	return found
}

// listedTitleForTest is the chat's entry as GET /api/chat-titles lists it.
func listedTitleForTest(t *testing.T, server *Server, workspaceID, chatID string) (store.ChatTitle, bool) {
	t.Helper()
	var titles []store.ChatTitle
	response := requestForTest(t, server, http.MethodGet, "/api/chat-titles?workspaceId="+workspaceID, "", http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &titles); err != nil {
		t.Fatal(err)
	}
	for _, title := range titles {
		if title.ChatID == chatID {
			return title, true
		}
	}
	return store.ChatTitle{}, false
}

// layoutForTest is the layout as GET /api/chat-layout answers it.
func layoutForTest(t *testing.T, server *Server, workspaceID string) store.ChatLayout {
	t.Helper()
	var layout store.ChatLayout
	response := requestForTest(t, server, http.MethodGet, "/api/chat-layout?workspaceId="+workspaceID, "", http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &layout); err != nil {
		t.Fatal(err)
	}
	return layout
}

func registerEventsWorkspaceForTest(t *testing.T, db store.Store, workspaceID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_" + workspaceID, Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: workspaceID, Name: "Workspace", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{ID: "agent_" + workspaceID, WorkspaceID: workspaceID, DeviceID: "dev_" + workspaceID, Provider: "codex", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestChatTitleAndLayoutChangesAreAnnounced(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_events")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_events", AgentID: "agent_ws_events", Provider: "codex", Prompt: "hi", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	expect := func(want ...string) {
		t.Helper()
		if want == nil {
			want = []string{}
		}
		if got := chatListEventsForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, want) {
			t.Fatalf("chat list events = %v, want %v", got, want)
		}
	}

	requestForTest(t, server, http.MethodPost, "/api/chats/"+session.ID+"/title", `{"title":"Renamed","workspaceId":"ws_events"}`, http.StatusOK)
	renamed := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, renamed); !reflect.DeepEqual(got, []string{"chat_titles_changed ws_events"}) {
		t.Fatalf("chat list events = %v", got)
	}
	listed, ok := listedTitleForTest(t, server, "ws_events", session.ID)
	if change := titlesChangesForTest(t, renamed)[0]; !ok || listed.Title != "Renamed" || !reflect.DeepEqual(change.Titles, []store.ChatTitle{listed}) || change.Removed != nil {
		t.Fatalf("rename announced %+v, want the chat's listed title %+v", change, listed)
	}
	requestForTest(t, server, http.MethodPost, "/api/chats/"+session.ID+"/title", `{"title":"","workspaceId":"ws_events"}`, http.StatusBadRequest)
	expect()
	requestForTest(t, server, http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_events","expectedRevision":0,"layout":{"groups":[{"id":"g","name":"Group"}],"positions":[]}}`, http.StatusOK)
	saved := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, saved); !reflect.DeepEqual(got, []string{"chat_layout_changed ws_events"}) {
		t.Fatalf("chat list events = %v", got)
	}
	if change := layoutChangesForTest(t, saved)[0]; change.Layout == nil || change.Layout.Revision != 1 || !reflect.DeepEqual(*change.Layout, layoutForTest(t, server, "ws_events")) {
		t.Fatalf("save announced %+v, want the saved layout", change)
	}
	requestForTest(t, server, http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_events","expectedRevision":0,"layout":{"groups":[],"positions":[]}}`, http.StatusConflict)
	expect()
	// Deleting a group deletes its chats, not their titles.
	requestForTest(t, server, http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_events","groupId":"g","expectedRevision":1}`, http.StatusOK)
	deleted := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, deleted); !reflect.DeepEqual(got, []string{"chat_layout_changed ws_events"}) {
		t.Fatalf("chat list events = %v", got)
	}
	if change := layoutChangesForTest(t, deleted)[0]; change.Layout == nil || change.Layout.Revision != 2 || len(change.Layout.Groups) != 0 {
		t.Fatalf("delete announced %+v, want the layout without the group", change)
	}
	if again, ok := listedTitleForTest(t, server, "ws_events", session.ID); !ok || !reflect.DeepEqual(again, listed) {
		t.Fatalf("titles after deleting a group: %+v, %v; want %+v", again, ok, listed)
	}
}

// The chat lists answer with an ETag: read again unchanged (also with the
// tag a compressing proxy weakened), they cost no body; changed, they answer
// anew.
func TestChatListsAnswerUnchangedReadsWithoutABody(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_etag")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_etag", AgentID: "agent_ws_etag", Provider: "codex", Prompt: "hi", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	conditional := func(path, tag string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("If-None-Match", tag)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		return response
	}
	for _, test := range []struct{ path, change, body string }{
		{"/api/chat-titles?workspaceId=ws_etag", "/api/chats/" + session.ID + "/title", `{"title":"Renamed","workspaceId":"ws_etag"}`},
		{"/api/chat-layout?workspaceId=ws_etag", "/api/chat-layout", `{"workspaceId":"ws_etag","expectedRevision":0,"layout":{"groups":[{"id":"g","name":"Group"}],"positions":[]}}`},
	} {
		first := requestForTest(t, server, http.MethodGet, test.path, "", http.StatusOK)
		etag := first.Header().Get("ETag")
		if etag == "" || first.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: ETag %q, Cache-Control %q", test.path, etag, first.Header().Get("Cache-Control"))
		}
		for _, tag := range []string{etag, "W/" + etag} {
			if response := conditional(test.path, tag); response.Code != http.StatusNotModified || response.Body.Len() != 0 {
				t.Fatalf("%s with If-None-Match %s: %d %q", test.path, tag, response.Code, response.Body.String())
			}
		}
		requestForTest(t, server, http.MethodPost, test.change, test.body, http.StatusOK)
		if response := conditional(test.path, etag); response.Code != http.StatusOK || response.Header().Get("ETag") == etag {
			t.Fatalf("%s after a change: %d, ETag %q", test.path, response.Code, response.Header().Get("ETag"))
		}
	}
}

// A naming job's events carry its chat's entry as GET /api/chat-titles
// lists it: the job's state while it runs, and, once it completed (its
// title no longer names it), the title it wrote.
func TestChatTitleJobEventsCarryTheChatsTitle(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_job")
	chat, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_job", AgentID: "agent_ws_job", Provider: "codex", Prompt: "hi", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	job, err := db.CreateChatTitleJob(ctx, chat.ID, store.CreateAgentSessionInput{WorkspaceID: "ws_job", AgentID: "agent_ws_job", Provider: "codex", Prompt: "name it"}, false)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	announced := func(want func(store.ChatTitle) bool) {
		t.Helper()
		changes := titlesChangesForTest(t, drainForTest(t, viewer))
		listed, ok := listedTitleForTest(t, server, "ws_job", chat.ID)
		if len(changes) != 1 || !ok || !want(listed) || !reflect.DeepEqual(changes[0].Titles, []store.ChatTitle{listed}) {
			t.Fatalf("announced %+v, listed %+v", changes, listed)
		}
	}
	server.sessions.changed(ctx, sessionCreated, job)
	announced(func(title store.ChatTitle) bool {
		return title.GenerationSessionID == job.ID && title.GenerationStatus == "queued"
	})
	completed, err := db.CompleteAgentSession(ctx, job.ID, `{"title":"Named by the job"}`, "")
	if err != nil {
		t.Fatal(err)
	}
	server.sessions.changed(ctx, sessionCompleted, completed)
	announced(func(title store.ChatTitle) bool {
		return title.Title == "Named by the job" && title.GenerationSessionID == ""
	})
}

// A naming job's state is its chat's title state: each of its session
// events is followed by chat_titles_changed. Other sessions, a group-naming
// job and transcript events are not.
func TestChatTitleJobEventsAnnounceTitles(t *testing.T) {
	server := NewServer(newTestStore(t))
	viewer := subscribeForTest(server.stream)
	naming := store.AgentSession{ID: "sess_naming", WorkspaceID: "ws_names", Source: "naming", Status: "queued"}
	ctx := context.Background()
	for _, change := range []sessionChange{sessionCreated, sessionStarted, sessionCompleted, sessionCompleted} {
		server.sessions.changed(ctx, change, naming)
	}
	server.sessions.changed(ctx, sessionCompleted, store.AgentSession{ID: "sess_group", WorkspaceID: "ws_names", Source: "naming", GroupNameTarget: "g"})
	server.sessions.changed(ctx, sessionCompleted, store.AgentSession{ID: "sess_chat", WorkspaceID: "ws_names", Source: "chat"})
	server.sessions.recorded(ctx, "ws_names", store.AgentSessionEvent{ID: "evt", SessionID: "sess_naming"})
	got := chatListEventsForTest(t, drainForTest(t, viewer))
	want := []string{"chat_titles_changed ws_names", "chat_titles_changed ws_names", "chat_titles_changed ws_names", "chat_titles_changed ws_names"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chat list events = %v, want %v", got, want)
	}
}

// Automatic group naming renames the group and announces its workspace's
// layout (the event used to carry the layout without a workspace).
func TestGroupNamingAnnouncesItsWorkspaceLayout(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_group")
	revision := int64(0)
	if _, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_group", ExpectedRevision: &revision,
		Layout: store.ChatLayout{Groups: []store.ChatLayoutGroup{{ID: "g", Name: "Placeholder"}}, Positions: []store.ChatPlacement{}}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	server.titles.SessionCompleted(ctx, store.AgentSession{ID: "sess_group", WorkspaceID: "ws_group", Source: "naming", GroupNameTarget: "g",
		Status: "completed", Response: `{"title":"Billing"}`})
	events := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, events); !reflect.DeepEqual(got, []string{"chat_layout_changed ws_group"}) {
		t.Fatalf("chat list events = %v", got)
	}
	layout, err := db.GetChatLayout(ctx, "ws_group")
	if err != nil || layout.Groups[0].Name != "Billing" {
		t.Fatalf("layout = %+v, %v", layout, err)
	}
	if change := layoutChangesForTest(t, events)[0]; change.Layout == nil || !reflect.DeepEqual(*change.Layout, layout) {
		t.Fatalf("announced %+v, want the renamed layout %+v", change, layout)
	}
}

func TestCreatedSessionAnnouncesItsChatListChanges(t *testing.T) {
	server := NewServer(newTestStore(t))
	viewer := subscribeForTest(server.stream)
	for _, test := range []struct {
		session store.AgentSession
		want    []string
	}{
		{store.AgentSession{WorkspaceID: "ws_new"}, []string{}},
		{store.AgentSession{WorkspaceID: "ws_new", ParentSessionID: "sess_parent"}, []string{"chat_layout_changed ws_new"}},
		{store.AgentSession{WorkspaceID: "ws_new", ParentSessionID: "sess_parent", IssueID: "iss_1"}, []string{}},
		{store.AgentSession{WorkspaceID: "ws_new", AdoptedChatID: "native_chat"}, []string{"chat_titles_changed ws_new", "chat_layout_changed ws_new"}},
	} {
		server.chats.sessionCreated(test.session)
		if got := chatListEventsForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("%+v: %v, want %v", test.session, got, test.want)
		}
	}
}

// dataChangesForTest keeps the foundry_data_changed events' workspaces.
func dataChangesForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	found := []string{}
	for _, event := range events {
		if event.kind != browserevent.FoundryDataChanged {
			continue
		}
		var payload map[string]any
		err := json.Unmarshal(event.payload, &payload)
		if _, named := payload["resources"]; err != nil || len(payload) > 2 || len(payload) == 2 && !named {
			t.Fatalf("foundry_data_changed payload = %s, want {\"workspaceId\": …, \"resources\": […]}", event.payload)
		}
		workspaceID, ok := payload["workspaceId"].(string)
		if !ok {
			t.Fatalf("foundry_data_changed payload = %s", event.payload)
		}
		found = append(found, workspaceID)
	}
	return found
}

// sessionEndsForTest keeps the agent_session_created and
// agent_session_completed events, as "type id status".
func sessionEndsForTest(t *testing.T, events []streamedForTest) []string {
	t.Helper()
	found := []string{}
	for _, event := range events {
		if event.kind != browserevent.AgentSessionCreated && event.kind != browserevent.AgentSessionCompleted {
			continue
		}
		var session store.AgentSession
		if err := json.Unmarshal(event.payload, &session); err != nil {
			t.Fatal(err)
		}
		found = append(found, string(event.kind)+" "+session.ID+" "+session.Status)
	}
	return found
}

// A child an agent starts joins its parent's layout group, which is
// announced; when its device takes no more messages, its failure is told
// like any other end (agent_session_completed, which invalidates cached
// snapshots), and what reacts to an ended session is told it. It used to be
// announced only as a data change, which nothing on the server reacts to.
func TestAgentChildSessionAnnouncesLayoutAndInvalidatesOnFailure(t *testing.T) {
	db, parent := lineageFixture(t)
	token, err := db.(interface {
		MintAgentSessionToken(context.Context, string) (string, error)
	}).MintAgentSessionToken(context.Background(), parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	// Connected, but nothing reads what the server sends it.
	stalled := newDaemonConnection(server.hub, nil)
	stalled.send = make(chan wsEnvelope)
	server.hub.connections["dev_lineage"] = stalled
	viewer := subscribeForTest(server.stream)
	observer := &sessionObserverForTest{}
	sessionEventsForTest(server).observe(observer)
	revision := server.stream.Revision()
	request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_session","arguments":{"prompt":"child"}}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if !strings.Contains(response.Body.String(), "local daemon is not connected") {
		t.Fatalf("create_session = %s, want it to reach dispatch", response.Body.String())
	}
	events := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, events); !reflect.DeepEqual(got, []string{"chat_layout_changed ws_lineage"}) {
		t.Fatalf("chat list events = %v", got)
	}
	if got := dataChangesForTest(t, events); len(got) != 0 {
		t.Fatalf("data changes = %v, want the failure told as the child's end", got)
	}
	// The child is told first; the naming of the group it opened runs
	// alongside, and its job may be told too.
	ends := sessionEndsForTest(t, events)
	if len(ends) == 0 || !strings.HasPrefix(ends[0], "agent_session_created sess_") {
		t.Fatalf("session events = %v, want the child created first", ends)
	}
	failed := "agent_session_completed " + strings.Fields(ends[0])[1] + " failed"
	if !slices.Contains(ends, failed) {
		t.Fatalf("session events = %v, want %q", ends, failed)
	}
	if told := observer.told(failed); len(told) != 1 {
		t.Fatalf("observers were told %v, want the child's failure", observer.told("agent_session_completed"))
	}
	if server.stream.Revision() == revision {
		t.Fatal("the failure kept cached snapshots")
	}
}

// The chat list events reach exactly the streams that may view the workspace.
func TestChatListEventsFollowWorkspaceAccess(t *testing.T) {
	events := newNotifiersForTest(nil)
	member := subscribeReachForTest(events.stream, streamReach{scope: &accessScope{roles: map[string]string{"ws_a": store.WorkspaceRoleViewer}}})
	outsider := subscribeReachForTest(events.stream, streamReach{scope: &accessScope{roles: map[string]string{"ws_b": store.WorkspaceRoleOwner}}})
	agent := subscribeReachForTest(events.stream, streamReach{workspace: "ws_a"})
	events.chatList.titlesStale("ws_a")
	events.chatList.layoutStale("ws_a")
	events.chatList.titlesChanged("ws_a", []store.ChatTitle{{ChatID: "c", Title: "Secret"}}, []string{"d"})
	events.chatList.layoutChanged("ws_a", store.ChatLayout{Revision: 3, Groups: []store.ChatLayoutGroup{{ID: "g", Name: "Secret"}}})
	if len(member.C) != 4 || len(agent.C) != 4 || len(outsider.C) != 0 {
		t.Fatalf("delivered member %d, agent %d, outsider %d; want 4, 4, 0", len(member.C), len(agent.C), len(outsider.C))
	}
}

// device_status_changed carries the device as foundry-data lists it, less
// what depends on the viewer (owned) or only its owner sees.
func TestDeviceStatusCarriesTheListedDevice(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities": []string{"subagents"},
		"device": map[string]any{"id": "dev_status", "label": "Status", "status": "connected", "lastSeenLabel": "online",
			"runtimeSettings": map[string]any{"activeRuntimeTtlMs": 1000, "maxConcurrentTasks": 3}},
		"workspace": map[string]any{"id": "ws_status", "name": "Status", "localPath": t.TempDir()},
	})
	readWSTypeForTest(t, conn, "registered")

	var event struct {
		WorkspaceID string         `json:"workspaceId"`
		DeviceID    string         `json:"deviceId"`
		Status      string         `json:"status"`
		Device      map[string]any `json:"device"`
	}
	for _, streamed := range drainForTest(t, viewer) {
		if streamed.kind == "device_status_changed" {
			if err := json.Unmarshal(streamed.payload, &event); err != nil {
				t.Fatal(err)
			}
		}
	}
	if event.DeviceID != "dev_status" || event.WorkspaceID != "ws_status" || event.Status != "connected" || event.Device == nil {
		t.Fatalf("device_status_changed = %+v", event)
	}
	if _, leaked := event.Device["runtimeSettings"]; leaked {
		t.Fatalf("the event carries the owner's runtime settings: %v", event.Device)
	}
	var data struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := json.Unmarshal(requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId=ws_status", "", http.StatusOK).Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	for _, listed := range data.Devices {
		if listed["id"] != "dev_status" {
			continue
		}
		delete(listed, "owned")
		delete(listed, "runtimeSettings")
		if !reflect.DeepEqual(listed, event.Device) {
			t.Fatalf("event device %v\nlisted device %v", event.Device, listed)
		}
		return
	}
	t.Fatal("foundry-data does not list the device")
}

// Claiming an Issue starts it and queues its session without a session or
// Issue event; the claim is announced as a data change of its workspace.
func TestClaimedIssueExecutionIsAnnounced(t *testing.T) {
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	db := newTestStore(t)
	server := NewServer(db)
	created := postJSONForTest(t, server, "/api/issues", `{"workspaceId":"ws_claim","sourceInput":"claimed issue","runtime":"mock"}`, http.StatusCreated)
	testfixture.ConfirmContract(t, db, created["id"].(string))
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	viewer := subscribeForTest(server.stream)
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities": []string{"issue_sessions"},
		"device":       map[string]any{"id": "dev_claim", "label": "Claim", "status": "connected", "lastSeenLabel": "online"},
		"workspace":    map[string]any{"id": "ws_claim", "name": "Claim", "localPath": t.TempDir()},
	})
	readWSTypeForTest(t, conn, "registered")
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	readWSUntilForTest(t, conn, "run_session", &run)
	if run.Session.Role != store.AgentSessionRoleIssueExecution {
		t.Fatalf("dispatched %+v, want the Issue's execution session", run.Session)
	}
	// The hello's registration created the workspace (announced too), then
	// the claim.
	for announced := 0; announced < 2; {
		change := payloadForTest[browserevent.FoundryDataChangedPayload](t, nextStreamedForTest(t, viewer, browserevent.FoundryDataChanged))
		if change.WorkspaceID == "ws_claim" {
			announced++
		}
	}
}

// A group-naming job its device cannot take fails, and its failure is told
// like any other end (agent_session_completed), also to what reacts to
// ended sessions. It used to be announced only as a data change.
func TestUndeliveredGroupNamingIsAnnounced(t *testing.T) {
	db, parent := lineageFixture(t)
	server := NewServer(db)
	stalled := newDaemonConnection(server.hub, nil)
	stalled.send = make(chan wsEnvelope)
	server.hub.connections["dev_lineage"] = stalled
	viewer := subscribeForTest(server.stream)
	observer := &sessionObserverForTest{}
	sessionEventsForTest(server).observe(observer)
	server.titles.StartGroupName(context.Background(), "ws_lineage", "group_1", parent.ID)
	events := drainForTest(t, viewer)
	if len(events) == 0 || events[0].kind != "agent_session_created" {
		t.Fatalf("events = %v, want the naming job created first", events)
	}
	if got := dataChangesForTest(t, events); len(got) != 0 {
		t.Fatalf("data changes = %v, want the failure told as the job's end", got)
	}
	ends := sessionEndsForTest(t, events)
	if len(ends) != 2 || ends[1] != "agent_session_completed "+strings.Fields(ends[0])[1]+" failed" {
		t.Fatalf("session events = %v, want the job created, then failed", ends)
	}
	if told := observer.told("agent_session_completed"); !reflect.DeepEqual(told, ends[1:]) {
		t.Fatalf("observers were told %v, want the job's failure", told)
	}
}

// A session that continues a device's chat named by its native session id
// (not its chat id) adopts the chat as well: the chat's title, queue and
// list position move to the session, and both lists are announced.
func TestSessionContinuingANativeSessionAnnouncesTheAdoptedChat(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_adopt")
	chat := store.ChatThread{ID: "native_codex_term", Provider: "codex", NativeSessionID: "term", Title: "Terminal work", UpdatedAt: "2026-10-09T01:00:00Z",
		Transcript: []store.TranscriptMessage{{ID: "u1:0", Kind: "user", Text: "hi"}, {ID: "a1:0", Kind: "assistant", Text: "hello"}}}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_adopt", Chats: []store.ChatThread{chat}}); err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	if _, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_adopt", ExpectedRevision: &zero, Layout: store.ChatLayout{
		Groups: []store.ChatLayoutGroup{}, Positions: []store.ChatPlacement{{ChatID: chat.ID}}}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	// Connected, but nothing reads what the server sends it.
	stalled := newDaemonConnection(server.hub, nil)
	stalled.send = make(chan wsEnvelope)
	server.hub.connections["dev_ws_adopt"] = stalled
	viewer := subscribeForTest(server.stream)
	response := requestForTest(t, server, http.MethodPost, "/api/agent-sessions",
		`{"workspaceId":"ws_adopt","agentId":"agent_ws_adopt","provider":"codex","prompt":"continue","nativeSessionId":"term","source":"chat"}`, http.StatusConflict)
	var session store.AgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil || session.ID == "" {
		t.Fatalf("created session = %s, %v", response.Body.String(), err)
	}
	events := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, events); !reflect.DeepEqual(got, []string{"chat_titles_changed ws_adopt", "chat_layout_changed ws_adopt"}) {
		t.Fatalf("chat list events = %v, want the adopted chat's title and position announced", got)
	}
	listed, ok := listedTitleForTest(t, server, "ws_adopt", session.ID)
	if change := titlesChangesForTest(t, events)[0]; !ok || listed.Title != "Terminal work" ||
		!reflect.DeepEqual(change.Titles, []store.ChatTitle{listed}) || !reflect.DeepEqual(change.Removed, []string{chat.ID}) {
		t.Fatalf("titles announced %+v, want the session's %+v and the native chat's gone", change, listed)
	}
	if change := layoutChangesForTest(t, events)[0]; change.Layout == nil || !reflect.DeepEqual(*change.Layout, layoutForTest(t, server, "ws_adopt")) {
		t.Fatalf("layout announced %+v, want the layout as saved", change)
	}
	queues := 0
	for _, event := range events {
		if event.kind == "chat_queue_changed" {
			queues++
		}
	}
	if queues != 2 {
		t.Fatalf("chat_queue_changed sent %d times, want the adopted chat's and the session's", queues)
	}
	layout, err := db.GetChatLayout(ctx, "ws_adopt")
	if err != nil || len(layout.Positions) != 1 || layout.Positions[0].ChatID != session.ID {
		t.Fatalf("layout = %+v, %v; want the chat's position held by the session", layout, err)
	}
}

// What an orchestrating session does to another (steer, stop, cancel) is
// recorded in that session's transcript and streamed to its viewers as the
// event stored, like its other transcript events. A person's own control
// records nothing.
func TestSessionControlAuditIsStreamed(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_audit")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_audit", AgentID: "agent_ws_audit", Provider: "codex", Prompt: "work", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	server.appendSessionControlAudit(ctx, session, "Steered by orchestrator", Actor{Kind: ActorAccount})
	if events := drainForTest(t, viewer); len(events) != 0 {
		t.Fatalf("a person's control was streamed: %+v", events)
	}
	orchestrator := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: "sess_orchestrator", WorkspaceID: "ws_audit"}}
	server.appendSessionControlAudit(ctx, session, "Steered by orchestrator", orchestrator)
	events := drainForTest(t, viewer)
	if len(events) != 1 || events[0].kind != browserevent.AgentSessionEvent {
		t.Fatalf("streamed %+v, want one transcript event", events)
	}
	var streamed store.AgentSessionEvent
	if err := json.Unmarshal(events[0].payload, &streamed); err != nil {
		t.Fatal(err)
	}
	stored, _, err := db.AgentSessionEventWindow(ctx, session.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var recorded *store.AgentSessionEvent
	for index := range stored {
		if stored[index].ID == streamed.ID {
			recorded = &stored[index]
		}
	}
	if recorded == nil || !reflect.DeepEqual(*recorded, streamed) || streamed.Label != "Steered by orchestrator" || streamed.At == "" {
		t.Fatalf("streamed %+v, stored %+v; want the stored event", streamed, recorded)
	}
}
