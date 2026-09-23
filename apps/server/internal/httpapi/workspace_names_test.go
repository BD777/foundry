package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRenameWorkspaceValidationAndCORS(t *testing.T) {
	backing := newEmptyTestStore(t)
	registerPromotionDaemon(t, backing, store.AgentProfileProjection{ID: "codex_local", Runtime: "codex", ConnectionType: "local_login"})
	server := NewServer(backing)
	requestForTest(t, server, http.MethodPatch, "/api/workspaces/missing", `{"name":"Renamed"}`, http.StatusNotFound)
	for _, body := range []string{`{"name":""}`, `{"name":"  "}`, `{"name":"two\nlines"}`, `{"name":"` + strings.Repeat("字", 121) + `"}`} {
		requestForTest(t, server, http.MethodPatch, "/api/workspaces/missing", body, http.StatusBadRequest)
	}
	workspaces, err := backing.ListWorkspaces(t.Context())
	if err != nil || len(workspaces) == 0 {
		t.Fatalf("fixture missing: %v", err)
	}
	requestForTest(t, server, http.MethodPatch, "/api/workspaces/"+workspaces[0].ID, `{"name":"  Friendly name  "}`, http.StatusOK)
	got, _ := backing.GetWorkspace(t.Context(), workspaces[0].ID)
	if got.Name != "Friendly name" || got.LocalPath != workspaces[0].LocalPath {
		t.Fatalf("rename changed path or failed: %+v", got)
	}
	req := httptest.NewRequest(http.MethodOptions, "/api/workspaces/"+workspaces[0].ID, nil)
	req.Header.Set("Origin", "http://127.0.0.1:31983")
	req.Header.Set("Access-Control-Request-Method", "PATCH")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, req)
	if !strings.Contains(response.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatal("PATCH not allowed by CORS")
	}
}
