package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A registration announces what it changed that device_status_changed does
// not carry; the same registration again announces nothing.
func TestRegistrationAnnouncesOnlyRealChanges(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	register := func(health string, want []string, why string) {
		t.Helper()
		body := `{"device":{"id":"dev_reg","label":"Device","status":"connected","lastSeenLabel":"online"},` +
			`"workspace":{"id":"ws_reg","name":"Workspace","localPath":"/tmp/ws_reg"},` +
			`"providerHealth":[{"provider":"codex","status":"` + health + `","authMode":"local_config","secretStored":"local"}]}`
		requestForTest(t, server, http.MethodPost, "/api/daemon/register", body, http.StatusOK)
		if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: foundry_data_changed for %v, want %v", why, got, want)
		}
	}
	register("healthy", []string{"", "ws_reg"}, "a new workspace")
	register("healthy", []string{}, "the same registration")
	register("unavailable", []string{""}, "provider health, which every workspace's view shows")
}

// A burst of changes is announced at once and once more when the interval
// ends, so the last change is never left unannounced; workspaces are
// throttled separately.
func TestDataChangesAreThrottledWithATrailingEdge(t *testing.T) {
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 150 * time.Millisecond
	defer func() { foundryDataChangeInterval = interval }()
	hub := newBrowserEventHub()
	viewer := subscribeForTest(hub, 64)
	for range 20 {
		hub.dataChanged("ws_burst")
	}
	hub.dataChanged("ws_other")
	if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_burst", "ws_other"}) {
		t.Fatalf("first of the burst = %v", got)
	}
	time.Sleep(300 * time.Millisecond)
	if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_burst"}) {
		t.Fatalf("end of the burst = %v, want one trailing event", got)
	}
	time.Sleep(200 * time.Millisecond)
	if got := dataChangesForTest(t, drainForTest(t, viewer)); len(got) != 0 {
		t.Fatalf("quiet period = %v", got)
	}
	hub.dataChanged("ws_burst")
	if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_burst"}) {
		t.Fatalf("a change after a quiet interval = %v, want it at once", got)
	}
}

// A workspace's change reaches the streams that may view the workspace; a
// global one (no data, workspaceId "") reaches every stream, also when it
// resumes after missing it.
func TestDataChangesFollowWorkspaceAccess(t *testing.T) {
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	hub := newBrowserEventHub()
	subscribe := func(subscription *eventSubscription) *eventSubscription {
		subscription.ch, subscription.ended = make(chan []byte, 8), make(chan struct{})
		hub.mu.Lock()
		hub.subscribers[subscription] = struct{}{}
		hub.mu.Unlock()
		return subscription
	}
	member := subscribe(&eventSubscription{scope: &accessScope{roles: map[string]string{"ws_a": store.WorkspaceRoleViewer}}})
	outsider := subscribe(&eventSubscription{scope: &accessScope{roles: map[string]string{"ws_b": store.WorkspaceRoleViewer}}})
	hub.dataChanged("ws_a")
	hub.dataChanged("")
	if got := dataChangesForTest(t, drainForTest(t, member)); !reflect.DeepEqual(got, []string{"ws_a", ""}) {
		t.Fatalf("member got %v", got)
	}
	if got := dataChangesForTest(t, drainForTest(t, outsider)); !reflect.DeepEqual(got, []string{""}) {
		t.Fatalf("outsider got %v, want only the global change", got)
	}
	late := &eventSubscription{scope: &accessScope{roles: map[string]string{"ws_b": store.WorkspaceRoleViewer}}, ch: make(chan []byte, 8), ended: make(chan struct{})}
	replay, _ := hub.resume(late, hub.epoch+"-0")
	if len(replay) != 1 {
		t.Fatalf("replayed %d events to the outsider, want the global change", len(replay))
	}
}

// Writes to what foundry-data returns that have no event of their own are
// announced with the right scope; a refused write announces nothing.
func TestWritesWithoutTheirOwnEventAreAnnounced(t *testing.T) {
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_writes")
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	for _, test := range []struct {
		method, path, body string
		status             int
		want               []string
	}{
		{http.MethodPatch, "/api/workspaces/ws_writes", `{"name":"Renamed"}`, http.StatusOK, []string{""}},
		{http.MethodPatch, "/api/workspaces/ws_writes", `{"name":""}`, http.StatusBadRequest, []string{}},
		{http.MethodPatch, "/api/devices/dev_ws_writes", `{"name":"Studio"}`, http.StatusOK, []string{""}},
		{http.MethodPost, "/api/profiles", `{"runtime":"claude","label":"Relay","authMode":"custom","connectionType":"anthropic_compatible","baseUrl":"https://relay.example"}`, http.StatusCreated, []string{""}},
		// The catalog every view shows lists the workspaces using each skill.
		{http.MethodPut, "/api/workspaces/ws_writes/skills", `{"skillIds":[]}`, http.StatusOK, []string{"ws_writes", ""}},
	} {
		requestForTest(t, server, test.method, test.path, test.body, test.status)
		if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("%s %s: foundry_data_changed for %v, want %v", test.method, test.path, got, test.want)
		}
	}
	postJSONForTest(t, server, "/api/issues", `{"workspaceId":"ws_writes","sourceInput":"announced issue","runtime":"mock"}`, http.StatusCreated)
	if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, []string{"ws_writes"}) {
		t.Fatalf("POST /api/issues: foundry_data_changed for %v", got)
	}
}

// Evidence actions that change the Issue itself (its contract state and
// revision, or its current review) are announced for its workspace: their
// evidence_updated event leaves the Issue as the list shows it. A refused
// action announces nothing.
func TestEvidenceWritesThatChangeTheIssueAreAnnounced(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_evidence")
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_evidence", SourceInput: "announce evidence"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	call := func(method, path, body string, status int, want []string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "/api/issues/"+issue.ID+path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", fmt.Sprintf("announce-%d", time.Now().UnixNano()))
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("%s %s = %d, want %d: %s", method, path, response.Code, status, response.Body.String())
		}
		if got := dataChangesForTest(t, drainForTest(t, viewer)); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s %s: foundry_data_changed for %v, want %v", method, path, got, want)
		}
		return response
	}
	draft := func(base int) string {
		reason := "Specify the observable output"
		raw, err := json.Marshal(store.ContractDraftInput{BaseRevision: &base, ChangeReason: &reason, Content: store.ContractContent{
			Goal: store.RichContent{Text: fmt.Sprintf("Deliver output %d", base), Media: []store.ReferenceMedia{}}, InScope: []string{}, OutOfScope: []string{}, Constraints: []string{},
			Criteria: []store.AcceptanceCriterion{{ID: "criterion_output", Title: "Requested output", Statement: "The candidate contains the output", Required: true,
				ProofKind: "content_completeness", EvaluationMode: "agent", Rubric: store.RichContent{Text: "Inspect the output", Media: []store.ReferenceMedia{}},
				EvidenceRequirements: []store.EvidenceRequirement{{ID: "requirement_output", Description: "Exported output", AcceptedCarriers: []store.CarrierKind{"document"}, MinimumCount: 1, BindingPolicy: "system_observed"}}}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	contractOf := func(response *httptest.ResponseRecorder) store.IssueContract {
		var contract store.IssueContract
		if err := json.Unmarshal(response.Body.Bytes(), &contract); err != nil {
			t.Fatal(err)
		}
		return contract
	}
	announced := []string{"ws_evidence"}

	proposed := contractOf(call(http.MethodPost, "/contracts", draft(1), http.StatusOK, announced))
	call(http.MethodPost, fmt.Sprintf("/contracts/%d/confirm", proposed.Revision), `{"expectedContentDigest":"sha256:`+strings.Repeat("0", 64)+`"}`, http.StatusConflict, []string{})
	call(http.MethodPost, fmt.Sprintf("/contracts/%d/confirm", proposed.Revision), `{"expectedContentDigest":"`+proposed.ContentDigest+`"}`, http.StatusOK, announced)
	amendment := contractOf(call(http.MethodPost, "/contracts", draft(proposed.Revision), http.StatusOK, announced))
	call(http.MethodPost, fmt.Sprintf("/contracts/%d/discard", amendment.Revision), `{"reason":"Keep the confirmed scope"}`, http.StatusOK, announced)
	// The first review of the confirmed contract becomes the Issue's current
	// one; reading it again changes nothing.
	call(http.MethodGet, "/review", "", http.StatusOK, announced)
	call(http.MethodGet, "/review", "", http.StatusOK, []string{})
}

// Deleting a chat group deletes its chats and their sessions, which the
// workspace's data lists: it is announced with the chat list events.
func TestDeletingAChatGroupAnnouncesItsSessions(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerEventsWorkspaceForTest(t, db, "ws_group_delete")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_group_delete", AgentID: "agent_ws_group_delete", Provider: "codex", Prompt: "hi", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	revision := int64(0)
	if _, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_group_delete", ExpectedRevision: &revision, Layout: store.ChatLayout{
		Groups: []store.ChatLayoutGroup{{ID: "g", Name: "Group"}}, Positions: []store.ChatPlacement{{ChatID: session.ID, GroupID: "g"}}}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	viewer := subscribeForTest(server.events, 256)
	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	requestForTest(t, server, http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_group_delete","groupId":"g","expectedRevision":1}`, http.StatusOK)
	events := drainForTest(t, viewer)
	if got := chatListEventsForTest(t, events); !reflect.DeepEqual(got, []string{"chat_layout_changed ws_group_delete"}) {
		t.Fatalf("chat list events = %v", got)
	}
	if got := dataChangesForTest(t, events); !reflect.DeepEqual(got, []string{"ws_group_delete"}) {
		t.Fatalf("foundry_data_changed for %v, want the workspace", got)
	}
	sessions, err := db.ListAgentSessionSummaries(ctx, "ws_group_delete")
	if err != nil || len(sessions) != 0 {
		t.Fatalf("sessions after deleting their group = %d, %v; want none", len(sessions), err)
	}
}
