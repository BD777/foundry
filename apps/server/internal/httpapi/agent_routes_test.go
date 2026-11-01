package httpapi

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// agentReaches reports whether a session token may call method path: the
// route the server matches for it is marked agent in routeTable.
func agentReaches(t *testing.T, method, path string) bool {
	t.Helper()
	server := NewServer(newTestStore(t))
	mux := http.NewServeMux()
	agents := map[string]bool{}
	for _, route := range server.routeTable() {
		mux.Handle(route.pattern, route.handler)
		agents[route.pattern] = route.agent
	}
	_, pattern := mux.Handler(httptest.NewRequest(method, path, nil))
	return agents[pattern]
}

// The routes a session token reaches are exactly these; adding one is a
// decision, not a side effect.
func TestAgentRouteSurface(t *testing.T) {
	want := []string{
		"GET /api/agent-profiles", "GET /api/agent-session-threads/{id}", "GET /api/agent-sessions",
		"GET /api/agent-sessions/{id}", "GET /api/agent-sessions/{id}/subagents",
		"GET /api/agent-sessions/{id}/subagents/{taskId}", "GET /api/agent-sessions/{id}/work",
		"GET /api/agents", "GET /api/chat-layout", "GET /api/chat-titles", "GET /api/chats",
		"GET /api/chats/{id}", "GET /api/chats/{id}/history", "GET /api/chats/{id}/queue",
		"GET /api/events", "GET /api/foundry-data", "POST /api/agent-profiles/models",
		"POST /api/agent-sessions", "POST /api/agent-sessions/{id}/cancel",
		"POST /api/agent-sessions/{id}/messages", "POST /api/chats/archive",
		"POST /api/chats/unarchive", "POST /api/chats/{id}/native-archive/retry",
		"POST /api/chats/{id}/title", "POST /api/mcp",
	}
	var got []string
	for _, route := range NewServer(newTestStore(t)).routeTable() {
		if route.agent {
			got = append(got, route.pattern)
		}
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("agent routes = %v\nwant %v", got, want)
	}
}

// A session token is refused before the route's own rule runs.
func TestSessionTokenRefusedOutsideAgentRoutes(t *testing.T) {
	db, chat := lineageFixture(t)
	server := NewServer(db)
	token, err := db.MintAgentSessionToken(t.Context(), chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int{"/api/workspaces": http.StatusForbidden, "/api/agent-sessions": http.StatusOK} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("GET %s with a session token = %d, want %d", path, response.Code, want)
		}
	}
}
