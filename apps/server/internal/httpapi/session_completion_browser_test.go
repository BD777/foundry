package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Opt-in isolated real-browser fixture. No native runtime, provider request,
// production account or production database is involved.
func TestCompletionReplayBrowserFixture(t *testing.T) {
	dir := os.Getenv("DEV024_BROWSER_DIR")
	if dir == "" {
		t.Skip("interactive browser fixture")
	}
	db := newEmptyTestStore(t)
	ctx := context.Background()
	s := startedQueueSession(t, db)
	server := withTestOwner(NewServerWithOptions(db, ServerOptions{WebDistDir: filepath.Join(dir, "web")}))
	live := httptest.NewUnstartedServer(nil)
	server.options.AllowedOrigin = "http://" + live.Listener.Addr().String()
	live.Config.Handler = server.Routes()
	live.Start()
	defer live.Close()
	c := newDaemonConnection(server.hub, nil)
	partial, _ := json.Marshal(wsSessionEventPayload{Event: store.AgentSessionEvent{ID: "dev024_partial", SessionID: s.ID, Label: "Response stream", Detail: "DEV024 synthetic answer begins", Level: "info"}})
	if err := c.onSessionEvent(ctx, wsEnvelope{ID: "partial", Type: wsSessionEventType, Payload: partial}); err != nil {
		t.Fatal(err)
	}
	info, _ := json.Marshal(map[string]string{"url": live.URL, "session": s.ID, "input": s.Input.ID, "workspace": s.WorkspaceID})
	if err := os.WriteFile(filepath.Join(dir, "browser-fixture.json"), info, 0600); err != nil {
		t.Fatal(err)
	}
	completed := false
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		if !completed {
			if _, err := os.Stat(filepath.Join(dir, "complete-request")); err == nil {
				p, _ := json.Marshal(wsSessionCompletedPayload{SessionID: s.ID, InputID: s.Input.ID, Response: "DEV024 synthetic answer begins and ends completely. 完整恢复，无需重跑。", NativeSessionID: "native_dev024_fixture"})
				if err := c.onSessionCompleted(ctx, wsEnvelope{ID: "saved_completion", Type: wsSessionCompleteType, Payload: p}); err != nil {
					t.Fatal(err)
				}
				if err := c.onSessionCompleted(ctx, wsEnvelope{ID: "duplicate_completion", Type: wsSessionCompleteType, Payload: p}); err != nil {
					t.Fatal(err)
				}
				current, err := db.GetAgentSessionRecord(ctx, s.ID)
				if err != nil {
					t.Fatal(err)
				}
				if current.Status != "completed" || current.Input.ID != s.Input.ID {
					t.Fatal("incorrect completion identity")
				}
				receipt, _ := json.Marshal(map[string]string{"status": current.Status, "input": current.Input.ID, "response": current.Response})
				if err := os.WriteFile(filepath.Join(dir, "completed.json"), receipt, 0600); err != nil {
					t.Fatal(err)
				}
				completed = true
			}
		}
		if _, err := os.Stat(filepath.Join(dir, "browser-done")); err == nil {
			if !completed {
				t.Fatal("browser ended before completion")
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("browser fixture timed out")
}
