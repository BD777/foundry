package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func downloadTestFixture(t *testing.T, capabilities []string, answer func(string, wsFileDownloadRequest) any) (isolationFixture, *fakeDevice, store.AgentSession) {
	t.Helper()
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	t.Cleanup(live.Close)
	handler := func(kind string) fakeAnswer {
		return func(raw json.RawMessage) (string, any) {
			var request struct {
				Path     string                 `json:"path"`
				Download *wsFileDownloadRequest `json:"download"`
			}
			if err := json.Unmarshal(raw, &request); err != nil || request.Download == nil {
				t.Errorf("download request: %s", raw)
				return kind, map[string]any{"error": "missing download request"}
			}
			return kind, answer(request.Path, *request.Download)
		}
	}
	device := connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": capabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w"},
		"agents":       []map[string]any{{"id": "agent_alice", "workspaceId": "ws_alice", "deviceId": "dev_alice", "deviceLabel": "Alice's laptop", "provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online"}},
	}, map[string]fakeAnswer{wsReadSessionFileType: handler(wsSessionFileReadType), wsReadFileType: handler(wsFileReadType)})
	session, err := f.server.store.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{AgentID: "agent_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "download synthetic files", Source: "chat", CreatedByUserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	return f, device, session
}
func downloadAnswer(data []byte, path string, request wsFileDownloadRequest) map[string]any {
	end := min(request.Offset+fileDownloadChunkBytes, int64(len(data)))
	return map[string]any{"path": path, "origin": "reference", "insideWorkspace": strings.HasPrefix(path, "/tmp/w/"), "kind": "binary", "downloadChunk": wsFileDownloadChunk{Offset: request.Offset, Size: int64(len(data)), Revision: "same-file", DataBase64: base64.StdEncoding.EncodeToString(data[request.Offset:end])}}
}
func TestFileDownloadsStreamCompleteBytes(t *testing.T) {
	data := bytes.Repeat([]byte("第😀行\r\n"), 65000) // larger than both preview limits
	f, device, session := downloadTestFixture(t, []string{fileDownloadCapability}, func(path string, request wsFileDownloadRequest) any { return downloadAnswer(data, path, request) })
	for _, path := range []string{
		"/api/agent-sessions/" + session.ID + "/files/download?path=" + url.QueryEscape("/tmp/w/数据.json"),
		"/api/workspace-files/download?workspaceId=ws_alice&path=" + url.QueryEscape("/tmp/w/数据.json"),
	} {
		response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, path, ""))
		expectStatus(t, response, http.StatusOK, "full download")
		if !bytes.Equal(response.Body.Bytes(), data) {
			t.Fatalf("download = %d bytes, want %d", response.Body.Len(), len(data))
		}
		_, params, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
		if err != nil || params["filename"] != "数据.json" {
			t.Fatalf("download filename: %v %v", params, err)
		}
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("download headers %v", response.Header())
		}
	}
	for _, kind := range []string{wsReadSessionFileType, wsReadFileType} {
		requests := device.received(kind)
		if len(requests) < 5 {
			t.Fatalf("%s: %d chunks", kind, len(requests))
		}
		sort.Slice(requests, func(i, j int) bool {
			var a, b struct {
				Download wsFileDownloadRequest `json:"download"`
			}
			_ = json.Unmarshal(requests[i], &a)
			_ = json.Unmarshal(requests[j], &b)
			return a.Download.Offset < b.Download.Offset
		})
		for i, raw := range requests {
			var request struct {
				Download wsFileDownloadRequest `json:"download"`
			}
			_ = json.Unmarshal(raw, &request)
			if request.Download.Offset != int64(i*fileDownloadChunkBytes) || (i > 0 && request.Download.Revision != "same-file") {
				t.Fatalf("chunk %d: %+v", i, request)
			}
		}
	}
}
func TestSessionFileDownloadsPreserveViewerPolicy(t *testing.T) {
	secret := []byte("download-content-must-not-leak")
	f, _, session := downloadTestFixture(t, []string{fileDownloadCapability}, func(path string, request wsFileDownloadRequest) any { return downloadAnswer(secret, path, request) })
	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleViewer, f.aliceID); err != nil {
		t.Fatal(err)
	}
	target := "/api/agent-sessions/" + session.ID + "/files/download?path="
	inside := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, target+url.QueryEscape("/tmp/w/file.json"), ""))
	expectStatus(t, inside, http.StatusOK, "viewer inside workspace")
	outside := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, target+url.QueryEscape("/tmp/outside/file.json"), ""))
	expectStatus(t, outside, http.StatusForbidden, "viewer outside reference")
	if bytes.Contains(outside.Body.Bytes(), secret) {
		t.Fatal("forbidden download leaked file content")
	}
	if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	member := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, target+url.QueryEscape("/tmp/outside/file.json"), ""))
	expectStatus(t, member, http.StatusOK, "member outside recorded reference")
}
func TestFileDownloadCapabilityAndDeadlines(t *testing.T) {
	f, device, _ := downloadTestFixture(t, nil, func(string, wsFileDownloadRequest) any { return nil })
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/workspace-files/download?workspaceId=ws_alice&path=file.json", ""))
	expectStatus(t, response, http.StatusConflict, "old worker")
	if !strings.Contains(response.Body.String(), "worker_update_required") || len(device.received(wsReadFileType)) != 0 {
		t.Fatal("old worker was asked for unknown download semantics")
	}
	old := fileDownloadChunkTimeout
	fileDownloadChunkTimeout = 30 * time.Millisecond
	defer func() { fileDownloadChunkTimeout = old }()
	f2 := newIsolationFixture(t)
	live := httptest.NewServer(f2.handler)
	defer live.Close()
	connectFakeDevice(t, live, f2.aliceDevice, map[string]any{"capabilities": []string{fileDownloadCapability}, "device": map[string]any{"id": "dev_alice", "status": "connected"}, "workspace": map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w"}}, nil)
	stalled := doAuthCall(t, f2.handler, f2.as(f2.alice, http.MethodGet, "/api/workspace-files/download?workspaceId=ws_alice&path=file.json", ""))
	expectStatus(t, stalled, http.StatusGatewayTimeout, "stalled worker")
	if stalled.Header().Get("Retry-After") != "1" || !strings.Contains(stalled.Body.String(), "device_slow") {
		t.Fatalf("timeout: %v %s", stalled.Header(), stalled.Body.String())
	}
}
func TestFileDownloadRefusalsAndInterruptedBody(t *testing.T) {
	f, _, _ := downloadTestFixture(t, []string{fileDownloadCapability}, func(path string, request wsFileDownloadRequest) any {
		switch path {
		case "large":
			return map[string]any{"code": "too_large", "error": "too large"}
		case "missing":
			return map[string]any{"code": "not_found", "error": "not found"}
		case "broken":
			return map[string]any{"downloadChunk": wsFileDownloadChunk{Offset: 0, Size: 5, Revision: "id", DataBase64: "not base64!"}}
		default:
			if request.Offset > 0 {
				return map[string]any{"code": "changed", "error": "changed"}
			}
			return downloadAnswer(bytes.Repeat([]byte{5}, 2*fileDownloadChunkBytes), path, request)
		}
	})
	for path, status := range map[string]int{"large": http.StatusRequestEntityTooLarge, "missing": http.StatusNotFound, "broken": http.StatusBadGateway} {
		response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/workspace-files/download?workspaceId=ws_alice&path="+path, ""))
		expectStatus(t, response, status, path)
	}
	partial := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/workspace-files/download?workspaceId=ws_alice&path=changes", ""))
	expectStatus(t, partial, http.StatusOK, "interrupted after headers")
	if partial.Body.Len() != fileDownloadChunkBytes || partial.Header().Get("Content-Length") != "131072" {
		t.Fatalf("partial response: %d %v", partial.Body.Len(), partial.Header())
	}
}
