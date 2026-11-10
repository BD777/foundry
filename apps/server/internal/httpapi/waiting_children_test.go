package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sort"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type waitingProjectionBackend struct {
	*sqlitestore.Store
	batches        [][]string
	outstandingErr error
}

func (s *waitingProjectionBackend) OutstandingChildTurns(ctx context.Context, parentIDs []string) (map[string][]store.OutstandingChildTurn, error) {
	s.batches = append(s.batches, append([]string(nil), parentIDs...))
	if s.outstandingErr != nil {
		return nil, s.outstandingErr
	}
	return s.Store.OutstandingChildTurns(ctx, parentIDs)
}

func TestFoundryDataStampsWaitingChildCountsInOneBatch(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_waiting_projection")

	parents := make([]store.AgentSession, 0, 2)
	children := make([]store.AgentSession, 0, 2)
	for _, title := range []string{"first", "second"} {
		parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_waiting_projection", AgentID: "agent_ws_waiting_projection",
			Provider: "codex", Prompt: title, Source: "chat",
		})
		if err != nil {
			t.Fatal(err)
		}
		child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_waiting_projection", AgentID: "agent_ws_waiting_projection",
			Provider: "codex", Prompt: title + " child", Source: "agent", ParentSessionID: parent.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.StartAgentSession(ctx, child.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
			t.Fatal(err)
		}
		if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_waiting_projection", AgentID: "agent_ws_waiting_projection",
			Provider: "codex", Prompt: title + " grandchild", Source: "agent", ParentSessionID: child.ID,
		}); err != nil {
			t.Fatal(err)
		}
		parents = append(parents, parent)
		children = append(children, child)
	}

	backing := &waitingProjectionBackend{Store: db}
	server := NewServer(backing)
	_, fields := foundryDataForTest(t, server, "?workspaceId=ws_waiting_projection&fields=agentSessions", nil)
	var listed []store.AgentSession
	if err := json.Unmarshal(fields[fieldAgentSessions], &listed); err != nil {
		t.Fatal(err)
	}
	counts := make(map[string]int, len(listed))
	for _, session := range listed {
		counts[session.ID] = session.WaitingChildCount
	}
	for _, parent := range parents {
		if counts[parent.ID] != 1 {
			t.Fatalf("parent %s waitingChildCount = %d, want 1", parent.ID, counts[parent.ID])
		}
	}
	if len(backing.batches) != 2 {
		t.Fatalf("waiting-count batches = %v, want one per recursion level", backing.batches)
	}
	for _, parent := range parents {
		if !containsString(backing.batches[0], parent.ID) {
			t.Fatalf("waiting-count batch %v lacks parent %s", backing.batches[0], parent.ID)
		}
	}
	for _, child := range children {
		if !containsString(backing.batches[1], child.ID) {
			t.Fatalf("second waiting-count batch %v lacks child %s", backing.batches[1], child.ID)
		}
	}

	backing.batches = nil
	response := requestForTest(t, server, http.MethodGet, "/api/agent-sessions/"+parents[0].ID+"?events=none", "", http.StatusOK)
	var opened store.AgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	if opened.WaitingChildCount != 1 || len(backing.batches) != 2 {
		t.Fatalf("open chat waitingChildCount = %d with batches %v, want 1 from one query per level", opened.WaitingChildCount, backing.batches)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestAgentSessionListKeepsSessionsWhenWaitingChildCountsFail(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_waiting_failure")
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting_failure", AgentID: "agent_ws_waiting_failure",
		Provider: "codex", Prompt: "parent", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting_failure", AgentID: "agent_ws_waiting_failure",
		Provider: "codex", Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	}); err != nil {
		t.Fatal(err)
	}

	backing := &waitingProjectionBackend{Store: db, outstandingErr: errors.New("count unavailable")}
	response := requestForTest(t, NewServer(backing), http.MethodGet, "/api/agent-sessions?workspaceId=ws_waiting_failure", "", http.StatusOK)
	var listed []store.AgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) == 0 {
		t.Fatal("session list is empty after a waiting-count failure")
	}
	for _, session := range listed {
		if session.WaitingChildCount != 0 {
			t.Fatalf("session %s waitingChildCount = %d after a count failure, want 0", session.ID, session.WaitingChildCount)
		}
	}
}

func TestChildStatusChangeRefreshesParentWorkspace(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerEventsWorkspaceForTest(t, db, "ws_waiting_parent")
	registerEventsWorkspaceForTest(t, db, "ws_waiting_child")
	grandparent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting_parent", AgentID: "agent_ws_waiting_parent",
		Provider: "codex", Prompt: "grandparent", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting_child", AgentID: "agent_ws_waiting_child",
		Provider: "codex", Prompt: "parent", Source: "agent", ParentSessionID: grandparent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting_child", AgentID: "agent_ws_waiting_child",
		Provider: "codex", Prompt: "child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	interval := foundryDataChangeInterval
	foundryDataChangeInterval = 0
	defer func() { foundryDataChangeInterval = interval }()
	server := NewServer(db)
	viewer := subscribeForTest(server.stream)
	server.sessions.Changed(ctx, sessions.Started, sessions.Slim(child))

	got := dataChangeResourcesForTest(t, drainForTest(t, viewer))
	sort.Strings(got)
	want := []string{"ws_waiting_child: agentSessions", "ws_waiting_parent: agentSessions"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projection changes = %v, want %v", got, want)
	}
}
