package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestSessionFramesAreForTheSessionViewersOnly(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_alice", "label": "Laptop", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w", "baseline": "main"},
		"agents": []map[string]any{{
			"id": "agent_alice", "workspaceId": "ws_alice", "deviceId": "dev_alice", "deviceLabel": "Laptop",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	ctx := context.Background()
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "browse", Source: "chat",
		CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	dir := "/tmp/w/.foundry/attachments/frames/" + session.ID + "/"
	record := func(index int, path string) string {
		id := fmt.Sprintf("frm_%03d", index)
		at := time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC).Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano)
		if err := f.server.store.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: fmt.Sprintf("evt_frame_%03d", index), SessionID: session.ID, At: at, Label: "Tool frame", Level: "info",
			Metadata: &store.AgentSessionEventMetadata{ToolFrame: &store.SessionToolFrame{
				ID: id, CallID: fmt.Sprintf("toolu_%d", index), Tool: "mcp__playwright__browser_take_screenshot",
				Source: "playwright-mcp", Path: path, MIMEType: "image/png", Bytes: 1000, Width: 1280, Height: 720, CapturedAt: at,
			}},
		}); err != nil {
			t.Fatal(err)
		}
		return id
	}
	outside := record(0, "/tmp/w/.foundry/attachments/elsewhere.png")
	for index := 1; index <= store.SessionToolFrameLimitCount+1; index++ {
		record(index, fmt.Sprintf("%s%03d.png", dir, index))
	}
	newest := fmt.Sprintf("frm_%03d", store.SessionToolFrameLimitCount+1)
	call := func(caller, path string) *httptest.ResponseRecorder {
		t.Helper()
		return doAuthCall(t, f.handler, f.as(caller, http.MethodGet, "/api/agent-sessions/"+session.ID+path, ""))
	}

	// Not shared: neither the list nor an image, and the device is not asked.
	expectStatus(t, call(f.bob, "/frames"), http.StatusNotFound, "stranger lists frames")
	expectStatus(t, call(f.bob, "/frames/"+newest+"/image?variant=preview"), http.StatusNotFound, "stranger reads a frame")

	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(ctx, "ws_alice", f.bobID, store.WorkspaceRoleViewer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	listed := call(f.bob, "/frames")
	expectStatus(t, listed, http.StatusOK, "viewer lists frames")
	var list store.SessionToolFrameList
	if err := json.Unmarshal(listed.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	// 202 recorded: the newest 200 stay, the oldest two are dropped.
	if len(list.Frames) != store.SessionToolFrameLimitCount || list.Dropped != 2 || list.Frames[len(list.Frames)-1].ID != newest || list.Limits.Count != 200 {
		t.Fatalf("frames %d dropped %d last %s", len(list.Frames), list.Dropped, list.Frames[len(list.Frames)-1].ID)
	}
	expectStatus(t, call(f.bob, "/frames/frm_001/image"), http.StatusGone, "a dropped frame")
	expectStatus(t, call(f.bob, "/frames/"+outside+"/image"), http.StatusGone, "the oldest frame is dropped first")
	expectStatus(t, call(f.bob, "/frames/frm_unknown/image"), http.StatusNotFound, "a frame the session never recorded")

	// A kept frame is read from the device by its recorded path.
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- call(f.bob, "/frames/"+newest+"/image?variant=preview") }()
	var request wsAttachmentReadPayload
	id := readWSUntilForTest(t, conn, "attachment_read", &request)
	if request.WorkspaceID != "ws_alice" || request.Path != fmt.Sprintf("%s%03d.png", dir, store.SessionToolFrameLimitCount+1) || request.Variant != "preview" {
		t.Fatalf("relayed %+v", request)
	}
	data := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3}
	writeWSIDForTest(t, conn, id, "attachment_chunk_read", map[string]any{"size": len(data), "mimeType": "image/png", "realPath": request.Path, "revision": "1", "dataBase64": base64.StdEncoding.EncodeToString(data)})
	select {
	case image := <-done:
		expectStatus(t, image, http.StatusOK, "viewer reads a frame")
		if image.Header().Get("Content-Type") != "image/png" || image.Body.Len() != len(data) {
			t.Fatalf("image %v %d", image.Header(), image.Body.Len())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("frame image did not answer")
	}

	// The side panel's state carries the newest frame only.
	state, err := f.server.store.AgentSessionStateEvents(ctx, session.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	var stateFrames []string
	for _, event := range state {
		if event.Metadata != nil && event.Metadata.ToolFrame != nil {
			stateFrames = append(stateFrames, event.Metadata.ToolFrame.ID)
		}
	}
	if len(stateFrames) != 1 || stateFrames[0] != newest {
		t.Fatalf("state frames %v", stateFrames)
	}
	// Agents read transcripts without frames.
	full, err := f.server.store.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range sessionInspectEvents(full.Events) {
		if event.label == "Tool frame" {
			t.Fatalf("inspect shows frame event %s", event.id)
		}
	}
}

func TestSessionTokensCannotReadFrames(t *testing.T) {
	for _, path := range []string{"/api/agent-sessions/sess_1/frames", "/api/agent-sessions/sess_1/frames/frm_1/image"} {
		if agentReaches(t, http.MethodGet, path) {
			t.Fatalf("a session token reaches %s", path)
		}
	}
}

func TestSessionFramePathStaysInTheSessionsFrames(t *testing.T) {
	workspace := store.WorkspaceProjection{LocalPath: "/w"}
	for path, want := range map[string]bool{
		"/w/.foundry/attachments/frames/sess_1/a.png":           true,
		"/w/.foundry/attachments/frames/sess_2/a.png":           false,
		"/w/.foundry/attachments/frames/sess_1/../sess_2/a.png": false,
		"/w/.foundry/attachments/a.png":                         false,
		"relative/a.png":                                        false,
	} {
		if got := sessionFramePath(workspace, "sess_1", path); got != want {
			t.Errorf("%s: %v, want %v", path, got, want)
		}
	}
}
