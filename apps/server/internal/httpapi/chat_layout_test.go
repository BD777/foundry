package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestChatLayoutHTTP(t *testing.T) {
	db := newTestStore(t)
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_layout"}, Workspace: store.WorkspaceProjection{ID: "ws_layout", Name: "Layout", LocalPath: t.TempDir()}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodGet, "/api/chat-layout", "", 400},
		{http.MethodGet, "/api/chat-layout?workspaceId=missing", "", 404},
		{http.MethodGet, "/api/chat-layout?workspaceId=ws_layout", "", 200},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_layout","layout":{"groups":[],"positions":[]}}`, 400},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_layout","expectedRevision":0,"layout":{"groups":[],"positions":[]}}`, 200},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_layout","expectedRevision":0,"layout":{"groups":[],"positions":[]}}`, 409},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_layout","expectedRevision":1,"layout":{"groups":[],"positions":[{"chatId":"a","groupId":"unknown"}]}}`, 400},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_layout","expectedRevision":1,"layout":{"groups":[{"id":"g","name":"Delete"}],"positions":[]}}`, 200},
		{http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_layout","groupId":"g"}`, 400},
		{http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_layout","groupId":"g","expectedRevision":1}`, 409},
		{http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_layout","groupId":"missing","expectedRevision":2}`, 404},
		{http.MethodPost, "/api/chat-layout/delete-group", `{"workspaceId":"ws_layout","groupId":"g","expectedRevision":2}`, 200},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		server.Routes().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}
