package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	storepkg "github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
	"github.com/gorilla/websocket"
)

func TestHealthz(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, response.Code)
	}

	var body healthResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if body.Status != "ok" {
		t.Fatalf("expected ok status, got %q", body.Status)
	}
}

func TestFoundryDataSupportsConditionalRefresh(t *testing.T) {
	server := NewServer(newTestStore(t))
	firstRequest := httptest.NewRequest(http.MethodGet, "/api/foundry-data", nil)
	firstResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(firstResponse, firstRequest)

	if firstResponse.Code != http.StatusOK {
		t.Fatalf("expected initial status %d, got %d", http.StatusOK, firstResponse.Code)
	}
	etag := firstResponse.Header().Get("ETag")
	if etag == "" {
		t.Fatal("expected foundry-data response to include an ETag")
	}

	conditionalRequest := httptest.NewRequest(http.MethodGet, "/api/foundry-data", nil)
	conditionalRequest.Header.Set("If-None-Match", etag)
	conditionalResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(conditionalResponse, conditionalRequest)

	if conditionalResponse.Code != http.StatusNotModified {
		t.Fatalf("expected conditional status %d, got %d", http.StatusNotModified, conditionalResponse.Code)
	}
	if conditionalResponse.Body.Len() != 0 {
		t.Fatalf("expected empty 304 response, got %q", conditionalResponse.Body.String())
	}
}

func TestAPIAuthorizationAndCORS(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	session := setupOwner(t, server, handler)

	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces"}),
		http.StatusUnauthorized, "request without a session")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces",
		headers: map[string]string{"Authorization": "Bearer control-secret"}}),
		http.StatusUnauthorized, "retired shared control token")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: session}),
		http.StatusOK, "logged-in request")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: session,
		origin: "https://attacker.example"}),
		http.StatusForbidden, "untrusted origin")

	preflight := doAuthCall(t, handler, authCall{method: http.MethodOptions, path: "/api/profiles/prof_1",
		origin: accountsTestOrigin, headers: map[string]string{"Access-Control-Request-Method": http.MethodPut}})
	if !strings.Contains(preflight.Header().Get("Access-Control-Allow-Methods"), http.MethodPut) {
		t.Fatalf("browser PUT routes are unreachable: %s", preflight.Header().Get("Access-Control-Allow-Methods"))
	}

	daemonServer := NewServerWithOptions(newTestStore(t), ServerOptions{})
	credential := pairTestDevice(t, daemonServer, "dev_cors", "machine-cors")
	register := httptest.NewRequest(http.MethodPost, "/api/daemon/register", strings.NewReader(registrationBody("dev_cors", "ws_cors")))
	register.Header.Set("Content-Type", "application/json")
	register.Header.Set(deviceCredentialHeader, credential)
	registered := httptest.NewRecorder()
	daemonServer.Routes().ServeHTTP(registered, register)
	if registered.Code != http.StatusOK {
		t.Fatalf("register device workspace: %d %s", registered.Code, registered.Body.String())
	}
	daemonRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/daemon/chats/sync",
		strings.NewReader(`{"workspaceId":"ws_cors","chats":[]}`),
	)
	daemonRequest.Header.Set("Content-Type", "application/json")
	daemonRequest.Header.Set(deviceCredentialHeader, credential)
	daemonResponse := httptest.NewRecorder()
	daemonServer.Routes().ServeHTTP(daemonResponse, daemonRequest)
	if daemonResponse.Code != http.StatusOK {
		t.Fatalf("expected paired daemon request to succeed, got %d: %s", daemonResponse.Code, daemonResponse.Body.String())
	}
}

func TestAgentProfileRejectsControlPlaneSecrets(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)

	postJSONForTest(t, server, "/api/agent-profiles", `{
		"runtime":"codex",
		"label":"Remote command",
		"configScope":"device",
		"connectionType":"custom_command",
		"command":"touch /tmp/remote-command"
	}`, http.StatusBadRequest)
}

func TestAPIRejectsUnknownJSONFields(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)

	postJSONForTest(t, server, "/api/issues", `{
		"sourceInput":"Create a strict request",
		"runtime":"mock",
		"unexpected":true
	}`, http.StatusBadRequest)
}

func TestDaemonWebSocketRequiresPairingAndTrustedOrigin(t *testing.T) {
	store := newTestStore(t)
	server := NewServerWithOptions(store, ServerOptions{
		AllowedOrigin: "http://127.0.0.1:31983",
	})
	credential := pairTestDevice(t, server, "dev_ws_auth", "machine-ws-auth")
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"

	_, response, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected websocket without pairing code to fail")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected websocket status 401, got %#v", response)
	}

	badOriginHeaders := http.Header{}
	badOriginHeaders.Set(deviceCredentialHeader, credential)
	badOriginHeaders.Set("Origin", "https://attacker.example")
	_, response, err = websocket.DefaultDialer.Dial(wsURL, badOriginHeaders)
	if err == nil {
		t.Fatal("expected websocket with untrusted origin to fail")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected websocket status 403, got %#v", response)
	}

	pairedHeaders := http.Header{}
	pairedHeaders.Set(deviceCredentialHeader, credential)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, pairedHeaders)
	if err != nil {
		t.Fatalf("expected paired websocket to connect: %v", err)
	}
	conn.Close()
}

func TestLocalImageFileIsLimitedToWorkspaceAttachments(t *testing.T) {
	db := newEmptyTestStore(t)
	workspacePath := t.TempDir()
	if err := db.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_image",
			Label:         "Image Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_image",
			Name:      "Image Workspace",
			LocalPath: workspacePath,
			Baseline:  "main",
		},
	}); err != nil {
		t.Fatalf("register image workspace: %v", err)
	}

	attachmentDir := filepath.Join(workspacePath, ".foundry", "attachments", "20260719")
	if err := os.MkdirAll(attachmentDir, 0o700); err != nil {
		t.Fatalf("create attachment directory: %v", err)
	}
	attachmentPath := filepath.Join(attachmentDir, "image.png")
	writePNGForTest(t, attachmentPath)

	server := NewServer(db)
	imageURL := "/api/local-files/image?path=" + url.QueryEscape(attachmentPath)
	imageResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(imageResponse, httptest.NewRequest(http.MethodGet, imageURL, nil))
	if imageResponse.Code != http.StatusOK {
		t.Fatalf("expected registered attachment image, got %d: %s", imageResponse.Code, imageResponse.Body.String())
	}
	if imageResponse.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("expected image/png, got %q", imageResponse.Header().Get("Content-Type"))
	}

	outsidePath := filepath.Join(t.TempDir(), "outside.png")
	writePNGForTest(t, outsidePath)
	outsideURL := "/api/local-files/image?path=" + url.QueryEscape(outsidePath)
	outsideResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(outsideResponse, httptest.NewRequest(http.MethodGet, outsideURL, nil))
	if outsideResponse.Code != http.StatusNotFound {
		t.Fatalf("expected outside image to be rejected, got %d", outsideResponse.Code)
	}

	symlinkPath := filepath.Join(attachmentDir, "outside-link.png")
	if err := os.Symlink(outsidePath, symlinkPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	symlinkURL := "/api/local-files/image?path=" + url.QueryEscape(symlinkPath)
	symlinkResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(symlinkResponse, httptest.NewRequest(http.MethodGet, symlinkURL, nil))
	if symlinkResponse.Code != http.StatusNotFound {
		t.Fatalf("expected escaping symlink to be rejected, got %d", symlinkResponse.Code)
	}
}

func TestBrowserEventHubStreamsEvents(t *testing.T) {
	hub := newBrowserEventHub()
	streamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.ServeHTTP(w, r.WithContext(contextWithScope(r.Context(), accessScope{all: true})))
	}))
	defer streamServer.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, streamServer.URL, nil)
	if err != nil {
		t.Fatalf("create event stream request: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open event stream: %v", err)
	}
	defer response.Body.Close()
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("expected event stream content type, got %q", contentType)
	}

	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data: ") {
				lines <- strings.TrimPrefix(line, "data: ")
				return
			}
		}
	}()

	hub.Publish("agent_session_event", map[string]string{"id": "evt_1"})
	select {
	case line := <-lines:
		var event browserEventEnvelope
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode streamed event: %v", err)
		}
		if event.Type != "agent_session_event" {
			t.Fatalf("expected agent_session_event, got %q", event.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for streamed event")
	}
}

func TestIssuesRoundTrip(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)

	createRequest := httptest.NewRequest(http.MethodPost, "/api/issues", strings.NewReader(`{"sourceInput":"Make the issue loop real","runtime":"mock"}`))
	createRequest.Header.Set("Idempotency-Key", "create-issue-loop")
	createRequest.Header.Set("Content-Type", "application/json")
	createResponse := httptest.NewRecorder()

	server.Routes().ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, createResponse.Code, createResponse.Body.String())
	}

	var created map[string]any
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		t.Fatalf("decode created issue: %v", err)
	}
	if created["status"] != "pending" {
		t.Fatalf("expected ready issue, got %#v", created["status"])
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/api/issues", nil)
	listResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, listResponse.Code)
	}
}

func TestDaemonChatSyncUpsertsNativeSession(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)

	first := postJSONForTest(t, server, "/api/daemon/chats/sync", `{
		"workspaceId":"ws_test",
		"chats":[{
			"id":"native_codex_session_1",
			"workspaceId":"ws_test",
			"provider":"codex",
			"nativeSessionId":"session_1",
			"title":"First title",
			"preview":"first",
			"handoffContext":"User: first",
			"readonly":false,
			"updatedLabel":"just now"
		}]
	}`, http.StatusOK)
	if first["count"] != float64(1) {
		t.Fatalf("expected first sync count 1, got %#v", first["count"])
	}

	postJSONForTest(t, server, "/api/daemon/chats/sync", `{
		"workspaceId":"ws_test",
		"chats":[{
			"id":"native_codex_session_1",
			"workspaceId":"ws_test",
			"provider":"codex",
			"nativeSessionId":"session_1",
			"title":"Updated title",
			"preview":"updated",
			"handoffContext":"User: updated",
			"transcript":[{"id":"reasoning","kind":"reasoning","text":"Saved summary","title":"思考摘要"},{"id":"answer","kind":"assistant","text":"Final answer"}],
			"readonly":false,
			"updatedLabel":"just now"
		}]
	}`, http.StatusOK)

	chats := getJSONForTest(t, server, "/api/chats", http.StatusOK)
	var synced map[string]any
	for _, chat := range chats {
		if chat["id"] == "native_codex_session_1" {
			synced = chat
			break
		}
	}
	if synced == nil {
		t.Fatalf("expected synced chat in %#v", chats)
	}
	if synced["title"] != "Updated title" || synced["preview"] != "updated" {
		t.Fatalf("expected chat to be updated, got %#v", synced)
	}
	if synced["handoffContext"] != nil || synced["transcript"] != nil {
		t.Fatalf("expected chat list to omit handoff context, got %#v", synced)
	}
	detail := getJSONObjectForTest(t, server, "/api/chats/native_codex_session_1", http.StatusOK)
	if detail["handoffContext"] != "User: updated" {
		t.Fatalf("expected chat detail to include handoff context, got %#v", detail)
	}
	transcript, ok := detail["transcript"].([]any)
	if !ok || len(transcript) != 2 || transcript[0].(map[string]any)["kind"] != "reasoning" || transcript[1].(map[string]any)["text"] != "Final answer" {
		t.Fatalf("expected structured transcript to survive sync and detail, got %#v", detail)
	}
}

func TestClaimedNativeChatIsMergedIntoFoundryThread(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()

	if err := db.RegisterDaemon(ctx, storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_test",
			Label:         "Test Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_test",
			Name:      "Test Workspace",
			LocalPath: "/tmp/ws_test",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_claude",
			WorkspaceID:   "ws_test",
			DeviceID:      "dev_test",
			DeviceLabel:   "Test Device",
			Provider:      "claude",
			ProfileID:     "profile_claude",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "device",
			ConfigLabel:   "local",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}

	if err := db.SyncChats(ctx, storepkg.SyncChatsInput{
		WorkspaceID: "ws_test",
		Chats: []storepkg.ChatThread{{
			ID:              "native_claude_native_1",
			WorkspaceID:     "ws_test",
			Provider:        "claude",
			ProfileID:       "profile_claude",
			NativeSessionID: "native_1",
			Title:           "hi",
			Preview:         "hi",
			UpdatedLabel:    "just now",
		}},
	}); err != nil {
		t.Fatalf("sync native chat: %v", err)
	}
	chats, err := db.ListChats(ctx, "")
	if err != nil {
		t.Fatalf("list chats before claim: %v", err)
	}
	if len(chats) != 1 {
		t.Fatalf("expected native chat before claim, got %#v", chats)
	}

	session, err := db.CreateAgentSession(ctx, storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_test",
		ThreadID:    "thread_foundry",
		AgentID:     "agent_claude",
		Provider:    "claude",
		ProfileID:   "profile_claude",
		Prompt:      "hi",
		Source:      "chat",
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if _, err := db.SetAgentSessionNativeSessionID(ctx, session.ID, "native_1"); err != nil {
		t.Fatalf("claim native session while agent session is running: %v", err)
	}
	chats, err = db.ListChats(ctx, "")
	if err != nil {
		t.Fatalf("list chats after running session claim: %v", err)
	}
	if len(chats) != 0 {
		t.Fatalf("expected running session claim to hide native chat, got %#v", chats)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "hello", "native_1"); err != nil {
		t.Fatalf("complete agent session: %v", err)
	}

	chats, err = db.ListChats(ctx, "")
	if err != nil {
		t.Fatalf("list chats after claim: %v", err)
	}
	if len(chats) != 0 {
		t.Fatalf("expected claimed native chat to be hidden, got %#v", chats)
	}

	if err := db.SyncChats(ctx, storepkg.SyncChatsInput{
		WorkspaceID: "ws_test",
		Chats: []storepkg.ChatThread{{
			ID:              "native_claude_native_1",
			WorkspaceID:     "ws_test",
			Provider:        "claude",
			ProfileID:       "profile_claude",
			NativeSessionID: "native_1",
			Title:           "hi again",
			Preview:         "hi again",
			UpdatedLabel:    "just now",
		}},
	}); err != nil {
		t.Fatalf("resync native chat: %v", err)
	}
	chats, err = db.ListChats(ctx, "")
	if err != nil {
		t.Fatalf("list chats after resync: %v", err)
	}
	if len(chats) != 0 {
		t.Fatalf("expected claimed native chat to stay hidden after resync, got %#v", chats)
	}
}

func TestDaemonProductionRoundTrip(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)

	created := postJSONForTest(t, server, "/api/issues", `{"sourceInput":"Produce a text acceptance artifact","runtime":"mock"}`, http.StatusCreated)
	testfixture.ConfirmContract(t, store, created["id"].(string))
	if created["status"] != "pending" {
		t.Fatalf("expected created issue to be ready, got %#v", created["status"])
	}

	postJSONForTest(t, server, "/api/daemon/register", `{
		"device":{"id":"dev_test","label":"Test Device","status":"connected","lastSeenLabel":"online"},
		"workspace":{"id":"ws_test","name":"Test Workspace","localPath":"/tmp/test","baseline":"main","contextSummary":"test","acceptedCount":0,"resolvedCount":0},
		"providerHealth":[{"provider":"claude","status":"missing_auth","authMode":"missing","secretStored":"local"}],
		"assets":[{"id":"asset_test","name":"Artifact archive","kind":"artifact_archive","status":"available","detail":"ready"}]
	}`, http.StatusOK)

	claimed := postJSONForTest(t, server, "/api/daemon/issues/claim", `{"deviceId":"dev_test"}`, http.StatusOK)
	issueID := claimed["id"].(string)
	if claimed["status"] != "in_progress" {
		t.Fatalf("expected claimed issue to be producing, got %#v", claimed["status"])
	}

	postJSONForTest(t, server, "/api/daemon/issues/"+issueID+"/runs", `{
		"run":{"id":"run_test","issueId":"`+issueID+`","status":"running","runtime":"mock","startedLabel":"just now","events":[]}
	}`, http.StatusOK)
	postJSONForTest(t, server, "/api/daemon/runs/run_test/events", `{
		"event":{"id":"evt_test","runId":"run_test","at":"just now","label":"Produced artifact","detail":"Wrote acceptance.md","level":"info"}
	}`, http.StatusOK)
	completed := postJSONForTest(t, server, "/api/daemon/issues/"+issueID+"/complete", `{
		"runId":"run_test",
		"artifact":{"id":"art_test","issueId":"`+issueID+`","kind":"text","title":"Acceptance artifact","summary":"Mock artifact produced"},
		"checks":["Mock worker completed"]
	}`, http.StatusOK)

	if completed["status"] != "verifying" {
		t.Fatalf("expected review status, got %#v", completed["status"])
	}
	if completed["artifact"] == nil {
		t.Fatal("expected completed issue to include artifact")
	}
}

func TestCreateAgentSessionRequiresConnectedDaemon(t *testing.T) {
	store := newEmptyTestStore(t)
	server := NewServer(store)

	postJSONForTest(t, server, "/api/daemon/register", `{
		"device":{"id":"dev_offline","label":"Offline Device","status":"connected","lastSeenLabel":"online"},
		"workspace":{"id":"ws_offline","name":"Offline Workspace","localPath":"/tmp/offline","baseline":"main","contextSummary":"offline test","acceptedCount":0,"resolvedCount":0},
		"providerHealth":[{"provider":"codex","status":"healthy","authMode":"local_config","secretStored":"local"}],
		"agents":[{"id":"agent_offline","workspaceId":"ws_offline","deviceId":"dev_offline","deviceLabel":"Offline Device","provider":"codex","status":"healthy","authMode":"local_config","secretStored":"local","configScope":"workspace","configLabel":"local","lastSeenLabel":"online"}]
	}`, http.StatusOK)

	postJSONForTest(t, server, "/api/agent-sessions", `{
		"workspaceId":"ws_offline",
		"agentId":"agent_offline",
		"provider":"codex",
		"prompt":"Do not persist this"
	}`, http.StatusConflict)

	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId=ws_offline", http.StatusOK)
	if len(sessions) != 0 {
		t.Fatalf("expected disconnected send to create no sessions, got %#v", sessions)
	}
}

func TestDeleteWorkspaceRemovesControlPlaneData(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_delete",
			Label:         "Delete Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:             "ws_delete",
			Name:           "Delete Workspace",
			LocalPath:      "/tmp/ws_delete",
			Baseline:       "main",
			ContextSummary: "delete test",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_delete",
			WorkspaceID:   "ws_delete",
			DeviceID:      "dev_delete",
			DeviceLabel:   "Delete Device",
			Provider:      "codex",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   "local",
			LastSeenLabel: "online",
		}},
		Assets: []storepkg.AssetProjection{{
			ID:          "asset_delete",
			WorkspaceID: "ws_delete",
			Name:        "Archive",
			Kind:        "artifact_archive",
			Status:      "available",
			Detail:      "ready",
		}},
		Skills: []storepkg.SkillPackRef{{
			ID:          "skill_delete",
			WorkspaceID: "ws_delete",
			Name:        "delete-skill",
			Version:     "1.0.0",
		}},
		WorkspaceFiles: []storepkg.WorkspaceFileEntry{{
			ID:          "file_delete",
			WorkspaceID: "ws_delete",
			Path:        "AGENTS.md",
			Name:        "AGENTS.md",
			Kind:        "file",
		}},
	}); err != nil {
		t.Fatalf("register workspace: %v", err)
	}
	if err := db.SyncChats(ctx, storepkg.SyncChatsInput{
		WorkspaceID: "ws_delete",
		Chats: []storepkg.ChatThread{{
			ID:           "chat_delete",
			WorkspaceID:  "ws_delete",
			Title:        "Delete chat",
			Preview:      "delete",
			UpdatedLabel: "just now",
		}},
	}); err != nil {
		t.Fatalf("sync chat: %v", err)
	}
	issue, err := db.CreateIssue(ctx, storepkg.CreateIssueInput{
		WorkspaceID: "ws_delete",
		SourceInput: "delete issue",
		Runtime:     "mock",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	run := storepkg.Run{
		ID:           "run_delete",
		IssueID:      issue.ID,
		WorkspaceID:  "ws_delete",
		Status:       "running",
		Runtime:      "mock",
		StartedLabel: "just now",
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}
	if err := db.AppendRunEvent(ctx, storepkg.RunEvent{
		ID:     "evt_delete",
		RunID:  run.ID,
		Label:  "event",
		Detail: "detail",
		Level:  "info",
	}); err != nil {
		t.Fatalf("append run event: %v", err)
	}
	if _, err := db.CompleteIssue(ctx, issue.ID, storepkg.CompleteIssueInput{
		RunID: run.ID,
		Artifact: storepkg.AcceptanceArtifact{
			ID:      "artifact_delete",
			IssueID: issue.ID,
			Kind:    "text",
			Title:   "artifact",
			Summary: "summary",
		},
	}); err != nil {
		t.Fatalf("complete issue: %v", err)
	}
	session, err := db.CreateAgentSession(ctx, storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_delete",
		AgentID:     "agent_delete",
		Provider:    "codex",
		Prompt:      "delete session",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, storepkg.AgentSessionEvent{
		ID:        "session_evt_delete",
		SessionID: session.ID,
		Label:     "event",
		Detail:    "detail",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append session event: %v", err)
	}

	server := NewServer(db)
	requestForTest(t, server, http.MethodDelete, "/api/workspaces/ws_delete", "", http.StatusConflict)
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", "native_delete"); err != nil {
		t.Fatalf("complete session before removing: %v", err)
	}
	deleted := deleteJSONForTest(t, server, "/api/workspaces/ws_delete", http.StatusOK)
	if deleted["id"] != "ws_delete" {
		t.Fatalf("expected deleted workspace payload, got %#v", deleted)
	}
	if _, err := db.GetWorkspace(ctx, "ws_delete"); err != storepkg.ErrNotFound {
		t.Fatalf("expected workspace to be removed, got %v", err)
	}
	agents, err := db.ListAgents(ctx, "ws_delete", "")
	assertNoItemsForTest(t, agents, err)
	files, err := db.ListWorkspaceFiles(ctx, "ws_delete")
	assertNoItemsForTest(t, files, err)
	assets, err := db.ListAssets(ctx, "ws_delete")
	assertNoItemsForTest(t, assets, err)
	skills, err := db.ListSkills(ctx, "ws_delete")
	assertNoItemsForTest(t, skills, err)
	chats, err := db.ListChats(ctx, "ws_delete")
	assertNoItemsForTest(t, chats, err)
	issues, err := db.ListIssues(ctx, "ws_delete")
	assertNoItemsForTest(t, issues, err)
	runs, err := db.ListRuns(ctx, "ws_delete")
	assertNoItemsForTest(t, runs, err)
	runEvents, err := db.ListRunEvents(ctx, "ws_delete")
	assertNoItemsForTest(t, runEvents, err)
	sessions, err := db.ListAgentSessions(ctx, "ws_delete")
	assertNoItemsForTest(t, sessions, err)
}

func TestDeleteWorkspaceNotifiesConnectedDaemon(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_forget",
			"label":         "Forget Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_forget",
			"name":           "Forget Workspace",
			"localPath":      "/tmp/ws_forget",
			"baseline":       "main",
			"contextSummary": "forget test",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	deleteDone := make(chan struct {
		payload map[string]any
		err     error
	}, 1)
	go func() {
		request, err := http.NewRequest(http.MethodDelete, testServer.URL+"/api/workspaces/ws_forget", nil)
		if err != nil {
			deleteDone <- struct {
				payload map[string]any
				err     error
			}{err: err}
			return
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			deleteDone <- struct {
				payload map[string]any
				err     error
			}{err: err}
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			deleteDone <- struct {
				payload map[string]any
				err     error
			}{err: errors.New(response.Status)}
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			deleteDone <- struct {
				payload map[string]any
				err     error
			}{err: err}
			return
		}
		deleteDone <- struct {
			payload map[string]any
			err     error
		}{payload: payload}
	}()
	var forget struct {
		Path        string `json:"path"`
		WorkspaceID string `json:"workspaceId"`
	}
	forgetEnvelopeID := readWSPayloadEnvelopeForTest(t, conn, "forget_workspace", &forget)
	if forget.WorkspaceID != "ws_forget" || forget.Path != "/tmp/ws_forget" {
		t.Fatalf("unexpected forget payload: %#v", forget)
	}
	writeWSIDForTest(t, conn, forgetEnvelopeID, "workspace_forgotten", map[string]any{
		"workspaceId": "ws_forget",
	})
	result := <-deleteDone
	if result.err != nil {
		t.Fatalf("delete workspace: %v", result.err)
	}
	deleted := result.payload
	if deleted["id"] != "ws_forget" {
		t.Fatalf("expected deleted workspace payload, got %#v", deleted)
	}
}

func TestDaemonWebSocketRoundTrip(t *testing.T) {
	store := newTestStore(t)
	server := NewServer(store)
	created := postJSONForTest(t, server, "/api/issues", `{"workspaceId":"ws_ws","sourceInput":"WebSocket scoped issue","runtime":"mock"}`, http.StatusCreated)
	testfixture.ConfirmContract(t, store, created["id"].(string))
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	// Exercise the actual browser SSE transport, not just durable event storage.
	streamContext, cancelStream := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelStream()
	streamRequest, err := http.NewRequestWithContext(streamContext, http.MethodGet, testServer.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	streamResponse, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer streamResponse.Body.Close()
	streamedEvents := make(chan browserEventEnvelope, 32)
	go func() {
		scanner := bufio.NewScanner(streamResponse.Body)
		for scanner.Scan() {
			if !strings.HasPrefix(scanner.Text(), "data: ") {
				continue
			}
			var event browserEventEnvelope
			if json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &event) == nil {
				select {
				case streamedEvents <- event:
				case <-streamContext.Done():
					return
				}
			}
		}
	}()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_ws",
			"label":         "WS Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_ws",
			"name":           "WS Workspace",
			"localPath":      "/tmp/ws",
			"baseline":       "main",
			"contextSummary": "websocket test",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	var runIssue struct {
		Issue map[string]any `json:"issue"`
	}
	readWSPayloadForTest(t, conn, "run_issue", &runIssue)
	issueID := runIssue.Issue["id"].(string)
	if runIssue.Issue["status"] != "in_progress" {
		t.Fatalf("expected websocket issue to be producing, got %#v", runIssue.Issue["status"])
	}

	writeWSForTest(t, conn, "run_started", map[string]any{
		"issueId": issueID,
		"run": map[string]any{
			"id":           "run_ws",
			"issueId":      issueID,
			"status":       "running",
			"runtime":      "mock",
			"startedLabel": "just now",
			"events":       []map[string]any{},
		},
	})
	readWSTypeForTest(t, conn, "ack")
	writeWSForTest(t, conn, "run_event", map[string]any{
		"event": map[string]any{
			"id":     "evt_ws",
			"runId":  "run_ws",
			"at":     "just now",
			"label":  "Response delta",
			"detail": "live response chunk",
			"level":  "info",
		},
	})
	readWSTypeForTest(t, conn, "ack")
	for received := false; !received; {
		select {
		case event := <-streamedEvents:
			if event.Type != "issue_run_event" {
				continue
			}
			payload := event.Payload.(map[string]any)
			if payload["runId"] != "run_ws" || payload["detail"] != "live response chunk" {
				t.Fatalf("unexpected Issue stream event: %#v", payload)
			}
			received = true
		case <-streamContext.Done():
			t.Fatal("Issue output did not reach browser SSE before completion")
		}
	}
	writeWSForTest(t, conn, "issue_completed", map[string]any{
		"issueId": issueID,
		"runId":   "run_ws",
		"artifact": map[string]any{
			"id":      "art_ws",
			"issueId": issueID,
			"kind":    "text",
			"title":   "WS artifact",
			"summary": "Produced over websocket",
		},
		"checks": []string{"WebSocket worker completed"},
	})
	readWSTypeForTest(t, conn, "ack")

	issue, err := store.GetIssue(context.Background(), issueID)
	if err != nil {
		t.Fatalf("get websocket issue: %v", err)
	}
	if issue.Status != "verifying" {
		t.Fatalf("expected issue in review, got %q", issue.Status)
	}
	if issue.Artifact == nil || issue.Artifact.ID != "art_ws" {
		t.Fatalf("expected websocket artifact, got %#v", issue.Artifact)
	}
}

func TestDaemonWebSocketFileReadAndAgentSession(t *testing.T) {
	store := newEmptyTestStore(t)
	server := NewServer(store)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_session",
			"label":         "Session Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_session",
			"name":           "Session Workspace",
			"localPath":      "/tmp/session",
			"baseline":       "main",
			"contextSummary": "session test",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{
			{"provider": "codex", "status": "healthy", "authMode": "local_config", "secretStored": "local"},
		},
		"assets": []map[string]any{},
		"agents": []map[string]any{
			{
				"id":            "agent_session_codex",
				"workspaceId":   "ws_session",
				"deviceId":      "dev_session",
				"deviceLabel":   "Session Device",
				"provider":      "codex",
				"status":        "healthy",
				"authMode":      "local_config",
				"secretStored":  "local",
				"configScope":   "workspace",
				"configLabel":   ".foundry/providers.yaml",
				"lastSeenLabel": "online",
			},
		},
		"workspaceFiles": []map[string]any{
			{
				"id":           "file_agents",
				"workspaceId":  "ws_session",
				"path":         "AGENTS.md",
				"name":         "AGENTS.md",
				"kind":         "file",
				"sizeLabel":    "21 B",
				"updatedLabel": "local",
			},
		},
	})
	readWSTypeForTest(t, conn, "registered")

	agents := getJSONForTest(t, server, "/api/agents", http.StatusOK)
	if len(agents) != 1 || agents[0]["provider"] != "codex" {
		t.Fatalf("expected registered codex agent, got %#v", agents)
	}
	files := getJSONForTest(t, server, "/api/workspace-files?workspaceId=ws_session", http.StatusOK)
	if len(files) != 1 || files[0]["path"] != "AGENTS.md" {
		t.Fatalf("expected registered AGENTS.md file, got %#v", files)
	}

	fileResponse := make(chan map[string]any, 1)
	go func() {
		fileResponse <- getJSONObjectForTest(t, server, "/api/workspace-files/read?workspaceId=ws_session&path=AGENTS.md", http.StatusOK)
	}()
	var readRequest struct {
		Path        string `json:"path"`
		WorkspaceID string `json:"workspaceId"`
	}
	readEnvelopeID := readWSPayloadEnvelopeForTest(t, conn, "read_file", &readRequest)
	if readRequest.Path != "AGENTS.md" {
		t.Fatalf("expected read request for AGENTS.md, got %#v", readRequest)
	}
	writeWSIDForTest(t, conn, readEnvelopeID, "file_read", map[string]any{
		"workspaceId": "ws_session",
		"path":        "AGENTS.md",
		"content":     "# Test\n\nRead only.",
		"truncated":   false,
	})
	fileRead := <-fileResponse
	if fileRead["content"] != "# Test\n\nRead only." {
		t.Fatalf("expected file content through websocket, got %#v", fileRead)
	}

	treeResponse := make(chan []map[string]any, 1)
	go func() {
		treeResponse <- getJSONForTest(t, server, "/api/workspace-files/tree?workspaceId=ws_session&path=src", http.StatusOK)
	}()
	var treeRequest struct {
		Path        string `json:"path"`
		WorkspaceID string `json:"workspaceId"`
	}
	treeEnvelopeID := readWSPayloadEnvelopeForTest(t, conn, "list_workspace_tree", &treeRequest)
	if treeRequest.Path != "src" {
		t.Fatalf("expected tree request for src, got %#v", treeRequest)
	}
	writeWSIDForTest(t, conn, treeEnvelopeID, "workspace_tree_listed", map[string]any{
		"workspaceId": "ws_session",
		"path":        "src",
		"entries": []map[string]any{
			{
				"id":          "tree_1",
				"name":        "components",
				"path":        "src/components",
				"isDirectory": true,
			},
			{
				"id":          "tree_2",
				"name":        "App.tsx",
				"path":        "src/App.tsx",
				"isDirectory": false,
				"extension":   ".tsx",
				"size":        1024,
			},
		},
	})
	treeEntries := <-treeResponse
	if len(treeEntries) != 2 || treeEntries[0]["name"] != "components" || treeEntries[1]["name"] != "App.tsx" {
		t.Fatalf("expected workspace tree entries, got %#v", treeEntries)
	}

	eventContext, cancelEvents := context.WithCancel(context.Background())
	defer cancelEvents()
	eventRequest, err := http.NewRequestWithContext(
		eventContext,
		http.MethodGet,
		testServer.URL+"/api/events",
		nil,
	)
	if err != nil {
		t.Fatalf("create lifecycle event request: %v", err)
	}
	eventResponse, err := http.DefaultClient.Do(eventRequest)
	if err != nil {
		t.Fatalf("open lifecycle event stream: %v", err)
	}
	defer eventResponse.Body.Close()
	streamedEvents := make(chan browserEventEnvelope, 8)
	go func() {
		scanner := bufio.NewScanner(eventResponse.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event browserEventEnvelope
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil {
				streamedEvents <- event
			}
		}
	}()

	created := postJSONForTest(t, server, "/api/agent-sessions", `{
		"workspaceId":"ws_session",
		"agentId":"agent_session_codex",
		"provider":"codex",
		"prompt":"Read AGENTS.md"
	}`, http.StatusCreated)
	sessionID := created["id"].(string)

	var runSession struct {
		Session map[string]any `json:"session"`
	}
	readWSPayloadForTest(t, conn, "run_session", &runSession)
	if runSession.Session["id"] != sessionID {
		t.Fatalf("expected run_session %s, got %#v", sessionID, runSession.Session)
	}
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": sessionID})
	readWSTypeForTest(t, conn, "ack")
	writeWSForTest(t, conn, "session_native_session_id", map[string]any{
		"sessionId":       sessionID,
		"nativeSessionId": "native_session_1",
	})
	readWSTypeForTest(t, conn, "ack")
	writeWSForTest(t, conn, "session_event", map[string]any{
		"event": map[string]any{
			"id":        "evt_session",
			"sessionId": sessionID,
			"at":        "just now",
			"label":     "Read AGENTS.md",
			"detail":    "ok",
			"level":     "info",
		},
	})
	readWSTypeForTest(t, conn, "ack")
	writeWSForTest(t, conn, "session_completed", map[string]any{
		"sessionId": sessionID,
		"response":  "Codex read AGENTS.md.",
	})
	readWSTypeForTest(t, conn, "ack")
	var naming struct {
		Session storepkg.AgentSession `json:"session"`
	}
	readWSPayloadForTest(t, conn, "run_session", &naming)
	if naming.Session.Source != "naming" || naming.Session.NativeSessionID != "" || naming.Session.ThreadID != "" || naming.Session.AgentID != "agent_session_codex" {
		t.Fatalf("expected isolated first-answer recap: %+v", naming.Session)
	}
	writeWSForTest(t, conn, "session_completed", map[string]any{"sessionId": naming.Session.ID, "response": `{"title":"Workspace inspection"}`})
	readWSTypeForTest(t, conn, "ack")
	titles := getJSONForTest(t, server, "/api/chat-titles?workspaceId=ws_session", http.StatusOK)
	if len(titles) != 1 || titles[0]["title"] != "Workspace inspection" {
		t.Fatalf("automatic title not saved: %+v", titles)
	}

	expectedStreamEvents := []string{
		"agent_session_created",
		"agent_session_started",
		"agent_session_native_session_id",
		"agent_session_event",
		"agent_session_completed",
	}
	for _, expected := range expectedStreamEvents {
		select {
		case streamed := <-streamedEvents:
			if streamed.Type != expected {
				t.Fatalf("expected streamed event %q, got %q", expected, streamed.Type)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for streamed event %q", expected)
		}
	}

	summaries := getJSONForTest(t, server, "/api/agent-sessions", http.StatusOK)
	if len(summaries) != 1 || summaries[0]["status"] != "completed" {
		t.Fatalf("expected completed agent session summary, got %#v", summaries)
	}
	if summaries[0]["nativeSessionId"] != "native_session_1" {
		t.Fatalf("expected native session id to be persisted before completion, got %#v", summaries[0])
	}
	if summaries[0]["startedAt"] == nil || summaries[0]["completedAt"] == nil {
		t.Fatalf("expected agent session timing metadata, got %#v", summaries[0])
	}
	assertNoAgentSessionDetailsForTest(t, summaries[0])

	detail := getJSONObjectForTest(t, server, "/api/agent-sessions/"+sessionID, http.StatusOK)
	if detail["response"] != "Codex read AGENTS.md." {
		t.Fatalf("expected detail response, got %#v", detail)
	}
	subagentsResponse := make(chan []map[string]any, 1)
	go func() {
		subagentsResponse <- getJSONForTest(
			t,
			server,
			"/api/agent-sessions/"+sessionID+"/subagents",
			http.StatusOK,
		)
	}()
	var subagentsRequest struct {
		SessionID   string `json:"sessionId"`
		WorkspaceID string `json:"workspaceId"`
	}
	subagentsEnvelopeID := readWSPayloadEnvelopeForTest(
		t,
		conn,
		"list_subagents",
		&subagentsRequest,
	)
	if subagentsRequest.SessionID != sessionID {
		t.Fatalf("unexpected subagent list request: %#v", subagentsRequest)
	}
	writeWSIDForTest(t, conn, subagentsEnvelopeID, "subagents_listed", map[string]any{
		"sessionId": sessionID,
		"subagents": []map[string]any{
			{
				"sessionId":     sessionID,
				"taskId":        "task_agent",
				"toolUseId":     "tool_agent",
				"title":         "Inspect workspace",
				"status":        "completed",
				"responseTexts": []string{"Done."},
			},
		},
	})
	subagents := <-subagentsResponse
	if len(subagents) != 1 || subagents[0]["taskId"] != "task_agent" {
		t.Fatalf("expected subagent discovery through websocket, got %#v", subagents)
	}
	subagentResponse := make(chan map[string]any, 1)
	go func() {
		subagentResponse <- getJSONObjectForTest(
			t,
			server,
			"/api/agent-sessions/"+sessionID+"/subagents/task_agent",
			http.StatusOK,
		)
	}()
	var subagentRequest struct {
		SessionID   string `json:"sessionId"`
		TaskID      string `json:"taskId"`
		WorkspaceID string `json:"workspaceId"`
	}
	subagentEnvelopeID := readWSPayloadEnvelopeForTest(
		t,
		conn,
		"read_subagent_transcript",
		&subagentRequest,
	)
	if subagentRequest.SessionID != sessionID || subagentRequest.TaskID != "task_agent" {
		t.Fatalf("unexpected subagent request: %#v", subagentRequest)
	}
	writeWSIDForTest(t, conn, subagentEnvelopeID, "subagent_transcript_read", map[string]any{
		"sessionId": sessionID,
		"taskId":    "task_agent",
		"toolUseId": "tool_agent",
		"title":     "Inspect workspace",
		"status":    "completed",
		"messages": []map[string]any{
			{"id": "msg_1", "role": "assistant", "content": "Done."},
		},
	})
	subagentRead := <-subagentResponse
	if subagentRead["title"] != "Inspect workspace" {
		t.Fatalf("expected subagent transcript through websocket, got %#v", subagentRead)
	}
	events, ok := detail["events"].([]any)
	if !ok || len(events) != 1 {
		t.Fatalf("expected one timestamped agent session event, got %#v", detail["events"])
	}
	event, ok := events[0].(map[string]any)
	if !ok || event["at"] == "just now" || event["at"] == "" {
		t.Fatalf("expected server timestamp on agent session event, got %#v", events[0])
	}
}

func TestAgentSessionDispatchesAfterWorkspaceReadyRegistration(t *testing.T) {
	store := newEmptyTestStore(t)
	server := NewServer(store)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_multi_session",
			"label":         "Multi Session Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_primary",
			"name":           "Primary Workspace",
			"localPath":      "/tmp/ws_primary",
			"baseline":       "main",
			"contextSummary": "primary",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	writeWSIDForTest(t, conn, "workspace_ready_ws_secondary", "workspace_ready", map[string]any{
		"registration": map[string]any{
			"device": map[string]any{
				"id":            "dev_multi_session",
				"label":         "Multi Session Device",
				"status":        "connected",
				"lastSeenLabel": "online",
			},
			"workspace": map[string]any{
				"id":             "ws_secondary",
				"name":           "Secondary Workspace",
				"localPath":      "/tmp/ws_secondary",
				"baseline":       "main",
				"contextSummary": "secondary",
				"acceptedCount":  0,
				"resolvedCount":  0,
			},
			"providerHealth": []map[string]any{
				{"provider": "codex", "status": "healthy", "authMode": "local_config", "secretStored": "local"},
			},
			"assets": []map[string]any{},
			"agents": []map[string]any{
				{
					"id":            "agent_secondary_codex",
					"workspaceId":   "ws_secondary",
					"deviceId":      "dev_multi_session",
					"deviceLabel":   "Multi Session Device",
					"provider":      "codex",
					"status":        "healthy",
					"authMode":      "local_config",
					"secretStored":  "local",
					"configScope":   "workspace",
					"configLabel":   ".foundry/providers.yaml",
					"lastSeenLabel": "online",
				},
			},
		},
	})
	readWSTypeForTest(t, conn, "registered")

	created := postJSONForTest(t, server, "/api/agent-sessions", `{
		"workspaceId":"ws_secondary",
		"agentId":"agent_secondary_codex",
		"provider":"codex",
		"prompt":"Run in secondary workspace"
	}`, http.StatusCreated)
	sessionID := created["id"].(string)

	var runSession struct {
		Session map[string]any `json:"session"`
	}
	readWSPayloadForTest(t, conn, "run_session", &runSession)
	if runSession.Session["id"] != sessionID {
		t.Fatalf("expected secondary run_session %s, got %#v", sessionID, runSession.Session)
	}
	if runSession.Session["workspaceId"] != "ws_secondary" {
		t.Fatalf("expected secondary workspace dispatch, got %#v", runSession.Session)
	}
}

func TestDaemonRegistrationRedeliversQueuedAgentSessions(t *testing.T) {
	store := newEmptyTestStore(t)
	workspace := storepkg.WorkspaceProjection{
		ID:             "ws_redeliver",
		Name:           "Redeliver Workspace",
		LocalPath:      "/tmp/ws_redeliver",
		Baseline:       "main",
		ContextSummary: "redeliver",
		AcceptedCount:  0,
		ResolvedCount:  0,
		DeviceID:       "dev_redeliver",
		DeviceLabel:    "Redeliver Device",
	}
	device := storepkg.DeviceProjection{
		ID:            "dev_redeliver",
		Label:         "Redeliver Device",
		Status:        "connected",
		LastSeenLabel: "online",
	}
	agent := storepkg.AgentProjection{
		ID:            "agent_redeliver_codex",
		WorkspaceID:   "ws_redeliver",
		DeviceID:      "dev_redeliver",
		DeviceLabel:   "Redeliver Device",
		Provider:      "codex",
		Status:        "healthy",
		AuthMode:      "local_config",
		SecretStored:  "local",
		ConfigScope:   "workspace",
		ConfigLabel:   ".foundry/providers.yaml",
		LastSeenLabel: "online",
	}
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device:         device,
		Workspace:      workspace,
		ProviderHealth: []storepkg.ProviderHealth{},
		Assets:         []storepkg.AssetProjection{},
		Agents:         []storepkg.AgentProjection{agent},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_redeliver",
		AgentID:     "agent_redeliver_codex",
		Provider:    "codex",
		Prompt:      "Recover queued session",
	})
	if err != nil {
		t.Fatalf("create queued agent session: %v", err)
	}

	server := NewServer(store)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_redeliver",
			"label":         "Redeliver Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_redeliver",
			"name":           "Redeliver Workspace",
			"localPath":      "/tmp/ws_redeliver",
			"baseline":       "main",
			"contextSummary": "redeliver",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents": []map[string]any{{
			"id":            "agent_redeliver_codex",
			"workspaceId":   "ws_redeliver",
			"deviceId":      "dev_redeliver",
			"deviceLabel":   "Redeliver Device",
			"provider":      "codex",
			"status":        "healthy",
			"authMode":      "local_config",
			"secretStored":  "local",
			"configScope":   "workspace",
			"configLabel":   ".foundry/providers.yaml",
			"lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")

	var runSession struct {
		Session map[string]any `json:"session"`
	}
	readWSPayloadForTest(t, conn, "run_session", &runSession)
	if runSession.Session["id"] != session.ID {
		t.Fatalf("expected redelivered queued session %s, got %#v", session.ID, runSession.Session)
	}
}

func TestListAgentSessionsRecoversCompletedSessionArtifacts(t *testing.T) {
	store := newEmptyTestStore(t)
	workspacePath := t.TempDir()
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_recover",
			Label:         "Recover Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_recover",
			Name:      "Recover Workspace",
			LocalPath: workspacePath,
			Baseline:  "main",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_recover_claude",
			WorkspaceID:   "ws_recover",
			DeviceID:      "dev_recover",
			DeviceLabel:   "Recover Device",
			Provider:      "claude",
			ProfileID:     "profile_recover",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   ".foundry/providers.yaml",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_recover",
		AgentID:     "agent_recover_claude",
		Provider:    "claude",
		ProfileID:   "profile_recover",
		Prompt:      "Recover me",
	})
	if err != nil {
		t.Fatalf("create queued session: %v", err)
	}
	writeClaudeSuccessArtifacts(t, workspacePath, session.ID, "Recovered response", "native_recovered")

	server := NewServer(store)
	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId=ws_recover", http.StatusOK)
	if len(sessions) != 1 {
		t.Fatalf("expected one recovered session, got %#v", sessions)
	}
	if sessions[0]["status"] != "completed" {
		t.Fatalf("expected recovered session to be completed, got %#v", sessions[0])
	}
	if sessions[0]["nativeSessionId"] != "native_recovered" {
		t.Fatalf("expected recovered native session id, got %#v", sessions[0])
	}
	if sessions[0]["completedAt"] == nil || sessions[0]["completedAt"] == "" {
		t.Fatalf("expected recovered session completion time, got %#v", sessions[0])
	}
	assertNoAgentSessionDetailsForTest(t, sessions[0])

	detail := getJSONObjectForTest(t, server, "/api/agent-sessions/"+session.ID, http.StatusOK)
	if detail["response"] != "Recovered response" {
		t.Fatalf("expected recovered detail response, got %#v", detail)
	}
}

func TestAgentSessionThreadEndpointReturnsCompleteTurnsAtomically(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_thread_api",
			Label:         "Thread API Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_thread_api",
			Name:      "Thread API Workspace",
			LocalPath: t.TempDir(),
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_thread_api",
			WorkspaceID:   "ws_thread_api",
			DeviceID:      "dev_thread_api",
			DeviceLabel:   "Thread API Device",
			Provider:      "codex",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   "local",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register thread API daemon: %v", err)
	}

	first, err := db.CreateAgentSession(ctx, storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_thread_api",
		AgentID:     "agent_thread_api",
		Provider:    "codex",
		Prompt:      "first",
	})
	if err != nil {
		t.Fatalf("create first thread API session: %v", err)
	}
	if err := db.AppendAgentSessionEvent(ctx, storepkg.AgentSessionEvent{
		ID:        "evt_thread_api_first",
		SessionID: first.ID,
		Label:     "Response stream",
		Detail:    "first answer",
		Level:     "info",
	}); err != nil {
		t.Fatalf("append first thread API event: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, first.ID, "first answer", "native_thread_api"); err != nil {
		t.Fatalf("complete first thread API session: %v", err)
	}
	second, err := db.CreateAgentSession(ctx, storepkg.CreateAgentSessionInput{
		WorkspaceID:     "ws_thread_api",
		ThreadID:        first.ID,
		NativeSessionID: "native_thread_api",
		AgentID:         "agent_thread_api",
		Provider:        "codex",
		Prompt:          "second",
	})
	if err != nil {
		t.Fatalf("create second thread API session: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, second.ID, "second answer", "native_thread_api"); err != nil {
		t.Fatalf("complete second thread API session: %v", err)
	}

	server := NewServer(db)
	thread := getJSONForTest(
		t,
		server,
		"/api/agent-session-threads/"+second.ID+"?workspaceId=ws_thread_api",
		http.StatusOK,
	)
	if len(thread) != 2 {
		t.Fatalf("expected two complete turns, got %#v", thread)
	}
	if thread[0]["response"] != "first answer" || thread[1]["response"] != "second answer" {
		t.Fatalf("expected complete thread responses, got %#v", thread)
	}
	if _, ok := thread[0]["events"]; !ok {
		t.Fatalf("expected thread endpoint to include event arrays, got %#v", thread[0])
	}
}

func TestListAgentSessionsRecoversCompletionMarkerWithoutProviderLogs(t *testing.T) {
	store := newEmptyTestStore(t)
	workspacePath := t.TempDir()
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_marker_recover",
			Label:         "Marker Recover Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_marker_recover",
			Name:      "Marker Recover Workspace",
			LocalPath: workspacePath,
			Baseline:  "main",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_marker_recover",
			WorkspaceID:   "ws_marker_recover",
			DeviceID:      "dev_marker_recover",
			DeviceLabel:   "Marker Recover Device",
			Provider:      "codex",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   ".foundry/providers.yaml",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_marker_recover",
		AgentID:     "agent_marker_recover",
		Provider:    "codex",
		Prompt:      "Recover from marker",
	})
	if err != nil {
		t.Fatalf("create queued session: %v", err)
	}
	writeSessionCompletionMarker(t, workspacePath, session.ID, "Marker recovered response", "native_marker_recovered")

	server := NewServer(store)
	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId=ws_marker_recover", http.StatusOK)
	if len(sessions) != 1 {
		t.Fatalf("expected one recovered session, got %#v", sessions)
	}
	if sessions[0]["status"] != "completed" {
		t.Fatalf("expected marker recovered completed session, got %#v", sessions[0])
	}
	if sessions[0]["nativeSessionId"] != "native_marker_recovered" {
		t.Fatalf("expected marker recovered native session id, got %#v", sessions[0])
	}
	assertNoAgentSessionDetailsForTest(t, sessions[0])

	detail := getJSONObjectForTest(t, server, "/api/agent-sessions/"+session.ID, http.StatusOK)
	if detail["response"] != "Marker recovered response" {
		t.Fatalf("expected marker recovered detail response, got %#v", detail)
	}
}

func TestListAgentSessionsFailsStaleRunningSession(t *testing.T) {
	store := newEmptyTestStore(t)
	workspacePath := t.TempDir()
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_stale_session",
			Label:         "Stale Session Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_stale_session",
			Name:      "Stale Session Workspace",
			LocalPath: workspacePath,
			Baseline:  "main",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_stale_session_claude",
			WorkspaceID:   "ws_stale_session",
			DeviceID:      "dev_stale_session",
			DeviceLabel:   "Stale Session Device",
			Provider:      "claude",
			ProfileID:     "profile_stale_session",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   ".foundry/providers.yaml",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_stale_session",
		AgentID:     "agent_stale_session_claude",
		Provider:    "claude",
		ProfileID:   "profile_stale_session",
		Prompt:      "Stale session",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := store.StartAgentSession(context.Background(), session.ID); err != nil {
		t.Fatalf("start session: %v", err)
	}

	server := withTestOwner(NewServerWithOptions(store, ServerOptions{
		AgentSessionStaleAfter: time.Nanosecond,
	}))
	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId=ws_stale_session", http.StatusOK)
	if len(sessions) != 1 || sessions[0]["status"] != "failed" {
		t.Fatalf("expected stale session to be failed, got %#v", sessions)
	}
	detail := getJSONObjectForTest(t, server, "/api/agent-sessions/"+session.ID, http.StatusOK)
	if !strings.Contains(fmt.Sprint(detail["error"]), "stopped reporting session activity") {
		t.Fatalf("expected stale-session error, got %#v", detail)
	}
}

func TestDaemonRegistrationSkipsRecoveredQueuedAgentSessions(t *testing.T) {
	store := newEmptyTestStore(t)
	workspacePath := t.TempDir()
	workspace := storepkg.WorkspaceProjection{
		ID:             "ws_redeliver_recovered",
		Name:           "Redeliver Recovered Workspace",
		LocalPath:      workspacePath,
		Baseline:       "main",
		ContextSummary: "redeliver recovered",
		AcceptedCount:  0,
		ResolvedCount:  0,
		DeviceID:       "dev_redeliver_recovered",
		DeviceLabel:    "Redeliver Recovered Device",
	}
	device := storepkg.DeviceProjection{
		ID:            "dev_redeliver_recovered",
		Label:         "Redeliver Recovered Device",
		Status:        "connected",
		LastSeenLabel: "online",
	}
	agent := storepkg.AgentProjection{
		ID:            "agent_redeliver_recovered_claude",
		WorkspaceID:   "ws_redeliver_recovered",
		DeviceID:      "dev_redeliver_recovered",
		DeviceLabel:   "Redeliver Recovered Device",
		Provider:      "claude",
		ProfileID:     "profile_redeliver_recovered",
		Status:        "healthy",
		AuthMode:      "local_config",
		SecretStored:  "local",
		ConfigScope:   "workspace",
		ConfigLabel:   ".foundry/providers.yaml",
		LastSeenLabel: "online",
	}
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device:         device,
		Workspace:      workspace,
		ProviderHealth: []storepkg.ProviderHealth{},
		Assets:         []storepkg.AssetProjection{},
		Agents:         []storepkg.AgentProjection{agent},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: workspace.ID,
		AgentID:     agent.ID,
		Provider:    "claude",
		ProfileID:   agent.ProfileID,
		Prompt:      "Already finished",
	})
	if err != nil {
		t.Fatalf("create queued agent session: %v", err)
	}
	writeClaudeSuccessArtifacts(t, workspacePath, session.ID, "Already recovered", "native_redeliver_recovered")

	server := NewServer(store)
	if err := server.hub.DispatchAgentSession(session); err != nil {
		t.Fatalf("dispatch recovered session: %v", err)
	}

	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId="+workspace.ID, http.StatusOK)
	if len(sessions) != 1 || sessions[0]["status"] != "completed" {
		t.Fatalf("expected recovered completed session summary, got %#v", sessions)
	}
	assertNoAgentSessionDetailsForTest(t, sessions[0])
}

func TestLateSessionStartedDoesNotReopenCompletedAgentSession(t *testing.T) {
	store := newEmptyTestStore(t)
	if err := store.RegisterDaemon(context.Background(), storepkg.DaemonRegistration{
		Device: storepkg.DeviceProjection{
			ID:            "dev_late_start",
			Label:         "Late Start Device",
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: storepkg.WorkspaceProjection{
			ID:        "ws_late_start",
			Name:      "Late Start Workspace",
			LocalPath: t.TempDir(),
			Baseline:  "main",
		},
		Agents: []storepkg.AgentProjection{{
			ID:            "agent_late_start_codex",
			WorkspaceID:   "ws_late_start",
			DeviceID:      "dev_late_start",
			DeviceLabel:   "Late Start Device",
			Provider:      "codex",
			Status:        "healthy",
			AuthMode:      "local_config",
			SecretStored:  "local",
			ConfigScope:   "workspace",
			ConfigLabel:   ".foundry/providers.yaml",
			LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	session, err := store.CreateAgentSession(context.Background(), storepkg.CreateAgentSessionInput{
		WorkspaceID: "ws_late_start",
		AgentID:     "agent_late_start_codex",
		Provider:    "codex",
		Prompt:      "finish first",
	})
	if err != nil {
		t.Fatalf("create agent session: %v", err)
	}
	if _, err := store.CompleteAgentSession(context.Background(), session.ID, "done", "native_done"); err != nil {
		t.Fatalf("complete agent session: %v", err)
	}

	server := NewServer(store)
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()

	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/daemon/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set websocket read deadline: %v", err)
	}

	writeWSForTest(t, conn, "hello", map[string]any{
		"device": map[string]any{
			"id":            "dev_late_start",
			"label":         "Late Start Device",
			"status":        "connected",
			"lastSeenLabel": "online",
		},
		"workspace": map[string]any{
			"id":             "ws_late_start",
			"name":           "Late Start Workspace",
			"localPath":      t.TempDir(),
			"baseline":       "main",
			"contextSummary": "late start",
			"acceptedCount":  0,
			"resolvedCount":  0,
		},
		"providerHealth": []map[string]any{},
		"assets":         []map[string]any{},
		"agents": []map[string]any{{
			"id":            "agent_late_start_codex",
			"workspaceId":   "ws_late_start",
			"deviceId":      "dev_late_start",
			"deviceLabel":   "Late Start Device",
			"provider":      "codex",
			"status":        "healthy",
			"authMode":      "local_config",
			"secretStored":  "local",
			"configScope":   "workspace",
			"configLabel":   ".foundry/providers.yaml",
			"lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	writeWSForTest(t, conn, "session_started", map[string]any{"sessionId": session.ID})
	readWSTypeForTest(t, conn, "ack")

	sessions := getJSONForTest(t, server, "/api/agent-sessions?workspaceId=ws_late_start", http.StatusOK)
	if len(sessions) != 1 || sessions[0]["status"] != "completed" {
		t.Fatalf("expected late session_started to preserve completed session summary, got %#v", sessions)
	}
	assertNoAgentSessionDetailsForTest(t, sessions[0])
}

func TestDevResetDemo(t *testing.T) {
	store := newTestStore(t)
	server := withTestOwner(NewServerWithOptions(store, ServerOptions{EnableDevReset: true}))

	postJSONForTest(t, server, "/api/issues", `{"sourceInput":"temporary test issue","runtime":"mock"}`, http.StatusCreated)
	listBefore := getJSONForTest(t, server, "/api/issues", http.StatusOK)
	if len(listBefore) != 11 {
		t.Fatalf("expected 11 issues before reset, got %d", len(listBefore))
	}

	postJSONForTest(t, server, "/api/dev/reset-demo", `{}`, http.StatusOK)
	listAfter := getJSONForTest(t, server, "/api/issues", http.StatusOK)
	if len(listAfter) != 10 {
		t.Fatalf("expected 10 seeded issues after reset, got %d", len(listAfter))
	}
}

func writePNGForTest(t *testing.T, path string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("create test PNG: %v", err)
	}
	defer file.Close()
	pixel := image.NewRGBA(image.Rect(0, 0, 1, 1))
	pixel.Set(0, 0, color.RGBA{R: 120, G: 80, B: 40, A: 255})
	if err := png.Encode(file, pixel); err != nil {
		t.Fatalf("encode test PNG: %v", err)
	}
}

func getJSONObjectForTest(t *testing.T, server *Server, path string, expectedStatus int) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s expected status %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	return payload
}

func getJSONForTest(t *testing.T, server *Server, path string, expectedStatus int) []map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s expected status %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	var payload []map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	return payload
}

func postJSONForTest(t *testing.T, server *Server, path string, body string, expectedStatus int) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if path == "/api/issues" {
		request.Header.Set("Idempotency-Key", fmt.Sprintf("test-create-%d", time.Now().UnixNano()))
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s expected status %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	var payload map[string]any
	if response.Body.Len() == 0 {
		return map[string]any{}
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	return payload
}

func deleteJSONForTest(t *testing.T, server *Server, path string, expectedStatus int) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodDelete, path, nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != expectedStatus {
		t.Fatalf("%s expected status %d, got %d: %s", path, expectedStatus, response.Code, response.Body.String())
	}
	var payload map[string]any
	if response.Body.Len() == 0 {
		return map[string]any{}
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	return payload
}

func assertNoItemsForTest[T any](t *testing.T, items []T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("list deleted workspace items: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected deleted workspace items to be empty, got %#v", items)
	}
}

func assertNoAgentSessionDetailsForTest(t *testing.T, session map[string]any) {
	t.Helper()
	if response, ok := session["response"]; ok && response != "" {
		t.Fatalf("expected list session to omit response detail, got %#v", session)
	}
	if events, ok := session["events"]; ok && events != nil {
		t.Fatalf("expected list session to omit event detail, got %#v", session)
	}
}

func writeWSForTest(t *testing.T, conn *websocket.Conn, messageType string, payload any) {
	t.Helper()
	writeWSIDForTest(t, conn, "test_"+messageType, messageType, payload)
}

func writeWSIDForTest(t *testing.T, conn *websocket.Conn, id string, messageType string, payload any) {
	t.Helper()
	if err := conn.WriteJSON(map[string]any{
		"id":      id,
		"payload": payload,
		"type":    messageType,
	}); err != nil {
		t.Fatalf("write websocket %s: %v", messageType, err)
	}
}

func readWSTypeForTest(t *testing.T, conn *websocket.Conn, expectedType string) {
	t.Helper()
	var envelope struct {
		Error   string          `json:"error"`
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := conn.ReadJSON(&envelope); err != nil {
		t.Fatalf("read websocket %s: %v", expectedType, err)
	}
	if envelope.Type != expectedType {
		t.Fatalf("expected websocket type %q, got %q error %q", expectedType, envelope.Type, envelope.Error)
	}
}

func readWSPayloadForTest(t *testing.T, conn *websocket.Conn, expectedType string, payload any) {
	t.Helper()
	_ = readWSPayloadEnvelopeForTest(t, conn, expectedType, payload)
}

func readWSPayloadEnvelopeForTest(t *testing.T, conn *websocket.Conn, expectedType string, payload any) string {
	t.Helper()
	var envelope struct {
		Error   string          `json:"error"`
		ID      string          `json:"id"`
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := conn.ReadJSON(&envelope); err != nil {
		t.Fatalf("read websocket %s: %v", expectedType, err)
	}
	if envelope.Type != expectedType {
		t.Fatalf("expected websocket type %q, got %q error %q", expectedType, envelope.Type, envelope.Error)
	}
	if err := json.Unmarshal(envelope.Payload, payload); err != nil {
		t.Fatalf("decode websocket payload %s: %v", expectedType, err)
	}
	return envelope.ID
}

func writeClaudeSuccessArtifacts(t *testing.T, workspacePath string, sessionID string, response string, nativeSessionID string) {
	t.Helper()
	sessionDir := filepath.Join(workspacePath, ".foundry", "sessions", sessionID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatalf("create session artifact dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "result.md"), []byte(response+"\n"), 0o600); err != nil {
		t.Fatalf("write session result artifact: %v", err)
	}
	messages := strings.Join([]string{
		`{"type":"assistant","session_id":"` + nativeSessionID + `"}`,
		`{"type":"result","subtype":"success","is_error":false,"session_id":"` + nativeSessionID + `"}`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(sessionDir, "claude-sdk.messages.jsonl"), []byte(messages), 0o600); err != nil {
		t.Fatalf("write session messages artifact: %v", err)
	}
}

func writeSessionCompletionMarker(t *testing.T, workspacePath string, sessionID string, response string, nativeSessionID string) {
	t.Helper()
	sessionDir := filepath.Join(workspacePath, ".foundry", "sessions", sessionID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		t.Fatalf("create session artifact dir: %v", err)
	}
	marker := map[string]any{
		"completedAt":     time.Now().UTC().Format(time.RFC3339Nano),
		"nativeSessionId": nativeSessionID,
		"response":        response,
		"sessionId":       sessionID,
		"status":          "completed",
	}
	bytes, err := json.Marshal(marker)
	if err != nil {
		t.Fatalf("encode completion marker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "completion.json"), append(bytes, '\n'), 0o600); err != nil {
		t.Fatalf("write completion marker: %v", err)
	}
}

func newTestStore(t *testing.T) *sqlitestore.Store {
	t.Helper()
	store, err := sqlitestore.OpenDemo(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return store
}

func newEmptyTestStore(t *testing.T) *sqlitestore.Store {
	t.Helper()
	store, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return store
}
