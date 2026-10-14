package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeDevice is a connected worker for tests: it says hello and answers the
// request types it has answers for, recording every request it received.
type fakeDevice struct {
	mu       sync.Mutex
	requests []fakeDeviceRequest
	conn     *websocket.Conn
	writeMu  sync.Mutex
}

type fakeDeviceRequest struct {
	Type    string
	Payload json.RawMessage
}

// fakeAnswer replies to one request: the reply's type and payload.
type fakeAnswer func(payload json.RawMessage) (string, any)

func connectFakeDevice(t *testing.T, live *httptest.Server, credential string, hello map[string]any, answers map[string]fakeAnswer) *fakeDevice {
	t.Helper()
	headers := http.Header{}
	if credential != "" {
		headers.Set(deviceCredentialHeader, credential)
	}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	writeWSForTest(t, conn, "hello", hello)
	readWSTypeForTest(t, conn, "registered")
	device := &fakeDevice{conn: conn}
	go func() {
		for {
			var envelope struct {
				ID      string          `json:"id"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if conn.ReadJSON(&envelope) != nil {
				return
			}
			device.mu.Lock()
			device.requests = append(device.requests, fakeDeviceRequest{envelope.Type, envelope.Payload})
			device.mu.Unlock()
			answer, ok := answers[envelope.Type]
			if !ok {
				continue
			}
			replyType, reply := answer(envelope.Payload)
			if device.write(map[string]any{"id": envelope.ID, "type": replyType, "payload": reply}) != nil {
				return
			}
		}
	}()
	return device
}

func (d *fakeDevice) write(envelope map[string]any) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	return d.conn.WriteJSON(envelope)
}

// tell sends a message of the worker's own and waits until the server
// acknowledged it.
func (d *fakeDevice) tell(t *testing.T, messageType string, payload any) {
	t.Helper()
	acks := len(d.received(wsAckType))
	if err := d.write(map[string]any{"id": "tell_" + messageType, "type": messageType, "payload": payload}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(d.received(wsAckType)) == acks {
		if time.Now().After(deadline) {
			t.Fatalf("%s was never acknowledged", messageType)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (d *fakeDevice) received(requestType string) []json.RawMessage {
	d.mu.Lock()
	defer d.mu.Unlock()
	payloads := []json.RawMessage{}
	for _, request := range d.requests {
		if request.Type == requestType {
			payloads = append(payloads, request.Payload)
		}
	}
	return payloads
}

// read_context reads what a session produced: the files its tools wrote and
// its answers named, a file's diff and content from its device, and its
// background work; a reader with Viewer reach gets what the web shows a
// Viewer.
func TestReadContextReadsWhatASessionProduced(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	server := NewServer(db)
	handler := server.Routes()
	live := httptest.NewServer(handler)
	defer live.Close()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "write the greeting", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	intPointer := func(value int) *int { return &value }
	exitCode := int64(0)
	for index, metadata := range []store.AgentSessionEventMetadata{
		{SessionFile: &store.SessionFileRecord{Path: "/work/foundry/greet.go", WorkspacePath: "greet.go", Origin: "tool", Op: "created", InGitRepo: true, InputID: "inp_1", Added: intPointer(3), Removed: intPointer(0), TotalAdded: intPointer(3), TotalRemoved: intPointer(0)}},
		{SessionFile: &store.SessionFileRecord{Path: "/work/foundry/greet.go", WorkspacePath: "greet.go", Origin: "tool", Op: "modified", InGitRepo: true, InputID: "inp_2", Added: intPointer(2), Removed: intPointer(1), TotalAdded: intPointer(5), TotalRemoved: intPointer(1)}},
		{SessionFile: &store.SessionFileRecord{Path: "/elsewhere/notes.md", Origin: "reference", Op: "referenced", InputID: "inp_2"}},
		{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{{ID: "bash_1", Kind: "bash", Description: "go test ./...", Status: "completed", ExitCode: &exitCode, HasOutput: true}}},
	} {
		metadata := metadata
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: "evt_out_" + string(rune('a'+index)), SessionID: child.ID, At: "2026-10-11T08:00:0" + string(rune('0'+index)) + "Z",
			Label: "File changed", Level: "info", Metadata: &metadata,
		}); err != nil {
			t.Fatal(err)
		}
	}
	before, after := "package greet\n\nfunc Hello() string { return \"hi\" }\n", "package greet\n\nfunc Hello() string { return \"hello\" }\n"
	device := connectFakeDevice(t, live, "", lineageHello(nil), map[string]fakeAnswer{
		wsReadSessionFileDiffType: func(raw json.RawMessage) (string, any) {
			var request wsReadSessionFileDiffPayload
			_ = json.Unmarshal(raw, &request)
			return wsSessionFileDiffReadType, store.SessionFileDiff{SessionID: request.SessionID, Path: request.Path, Origin: "tool", InsideWorkspace: true,
				InputID: request.InputID, Source: "hook", Before: &before, After: &after, BeforeLabel: "before", AfterLabel: "after", Added: intPointer(1), Removed: intPointer(1)}
		},
		wsReadSessionFileType: func(raw json.RawMessage) (string, any) {
			var request wsReadSessionFilePayload
			_ = json.Unmarshal(raw, &request)
			inside := !strings.HasPrefix(request.Path, "/elsewhere")
			origin := "tool"
			if !inside {
				origin = "reference"
			}
			return wsSessionFileReadType, store.SessionFileRead{SessionID: request.SessionID, Path: request.Path, Origin: origin, InsideWorkspace: inside, Kind: "text", Content: after}
		},
		wsReadBackgroundTaskOutputType: func(json.RawMessage) (string, any) {
			return wsBackgroundTaskOutputReadType, store.AgentBackgroundTaskOutput{SessionID: child.ID, TaskID: "bash_1", Command: "go test ./...", Content: "=== RUN TestHello\n--- PASS: TestHello\nok  greet\n", Bytes: 44, Kind: "bash"}
		},
	})
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, handler, token)

	changes, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "changes"})
	if isError {
		t.Fatal(changes)
	}
	var listed struct {
		Files []mcpSessionFile `json:"files"`
	}
	if err := json.Unmarshal([]byte(changes), &listed); err != nil || len(listed.Files) != 2 {
		t.Fatalf("changes = %s", changes)
	}
	greet, notes := listed.Files[1], listed.Files[0]
	if greet.Path != "/work/foundry/greet.go" || greet.Change != "created" || *greet.Added != 5 || *greet.Removed != 1 ||
		strings.Join(greet.Turns, ",") != "inp_1,inp_2" || !greet.InGit {
		t.Fatalf("greet.go = %+v", greet)
	}
	if notes.Change != "referenced" || notes.Added != nil {
		t.Fatalf("notes.md = %+v", notes)
	}

	diff, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "changes", "path": "/work/foundry/greet.go", "inputId": "inp_2"})
	if isError || !strings.Contains(diff, "turn: inp_2") || !strings.Contains(diff, "-func Hello() string { return \"hi\" }\n+func Hello() string { return \"hello\" }") {
		t.Fatalf("diff = %s", diff)
	}
	var diffRequest wsReadSessionFileDiffPayload
	if requests := device.received(wsReadSessionFileDiffType); len(requests) != 1 || json.Unmarshal(requests[0], &diffRequest) != nil || diffRequest.InputID != "inp_2" || diffRequest.SessionID != child.ID {
		t.Fatalf("diff requests = %s", requests)
	}
	file, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "file", "path": "/work/foundry/greet.go"})
	if isError || !strings.Contains(file, `return "hello"`) || !strings.Contains(file, "kind: text") {
		t.Fatalf("file = %s", file)
	}
	if text, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "file"}); !isError || !strings.Contains(text, "scope=file needs path") {
		t.Fatalf("file without path = %q", text)
	}
	background, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "background"})
	if isError || !strings.Contains(background, `"id":"bash_1"`) || !strings.Contains(background, `"exitCode":0`) {
		t.Fatalf("background = %s", background)
	}
	output, isError := call("read_context", map[string]any{"sessionId": child.ID, "scope": "background", "taskId": "bash_1", "maxBytes": 120})
	if isError || !strings.Contains(output, "command: go test ./...") || !strings.HasSuffix(output, "ok  greet\n") || strings.Contains(output, "=== RUN") {
		t.Fatalf("background output within maxBytes keeps its end: %q", output)
	}

	// An Issue's clarification reaches the workspace as Viewer: what the
	// tools wrote, but not a file outside it an answer named, nor
	// background output.
	discussed, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_lineage", SourceInput: "check the greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft := firstDraft(t, db, discussed.ID)
	_, clarification, err := db.AskClarification(ctx, store.AskClarificationInput{IssueID: discussed.ID, Revision: draft.Revision, ContentDigest: draft.ContentDigest,
		Message: "What changed?", ChangeReason: "Clarify"}, store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}, "clarify-outputs")
	if err != nil {
		t.Fatal(err)
	}
	viewerToken, err := db.MintAgentSessionToken(ctx, clarification.ID)
	if err != nil {
		t.Fatal(err)
	}
	viewer := mcpToolCaller(t, handler, viewerToken)
	if text, isError := viewer("read_context", map[string]any{"sessionId": child.ID, "scope": "file", "path": "/work/foundry/greet.go"}); isError || !strings.Contains(text, "hello") {
		t.Fatalf("a Viewer reads what the tools wrote: %q", text)
	}
	if text, isError := viewer("read_context", map[string]any{"sessionId": child.ID, "scope": "file", "path": "/elsewhere/notes.md"}); !isError || !strings.Contains(text, "needs Member") || strings.Contains(text, "hello") {
		t.Fatalf("a Viewer reads a named file outside the workspace: %q", text)
	}
	if text, isError := viewer("read_context", map[string]any{"sessionId": child.ID, "scope": "background", "taskId": "bash_1"}); !isError || !strings.Contains(text, "needs Member") {
		t.Fatalf("a Viewer reads background output: %q", text)
	}
}

// Files a session hands another arrive as a person's attachments do: read
// from the caller's device inside its workspace, written into the
// attachments of the workspace the receiving session runs in, on its own
// device. One call's files share a folder under their own names, and are
// published only once the session they come with is accepted.
func TestAttachmentsHandFilesToASessionOnAnotherDevice(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	live := httptest.NewServer(f.handler)
	defer live.Close()
	ownership := f.server.store.(store.OwnershipStore)
	if err := ownership.SetWorkspaceMember(ctx, "ws_bob", f.aliceID, store.WorkspaceRoleMember, f.bobID); err != nil {
		t.Fatal(err)
	}
	hello := func(device, workspace, path string, capabilities []string) map[string]any {
		return map[string]any{
			"capabilities": capabilities,
			"device":       map[string]any{"id": device, "label": device, "status": "connected", "lastSeenLabel": "online"},
			"workspace":    map[string]any{"id": workspace, "name": "W", "localPath": path, "baseline": "main", "contextSummary": "", "acceptedCount": 0, "resolvedCount": 0},
			"agents": []map[string]any{{
				"id": "agent_" + workspace, "workspaceId": workspace, "deviceId": device, "provider": "claude", "status": "healthy",
				"authMode": "local_config", "secretStored": "local", "configScope": "workspace", "configLabel": "local", "lastSeenLabel": "online",
			}},
		}
	}
	content := []byte(strings.Repeat("plan line\n", 120_000)) // over one chunk
	alice := connectFakeDevice(t, live, f.aliceDevice, hello("dev_alice", "ws_alice", "/work/alice", []string{store.DaemonCapabilityAttachmentFiles}), map[string]fakeAnswer{
		wsAttachmentReadType: func(raw json.RawMessage) (string, any) {
			var request wsAttachmentReadPayload
			_ = json.Unmarshal(raw, &request)
			if request.Scope != "workspace" || !strings.HasPrefix(request.Path, "/work/alice/") {
				return wsAttachmentChunkReadType, map[string]any{"error": "file is outside the workspace", "code": "invalid_path"}
			}
			end := min(int(request.Offset)+attachmentChunkBytes, len(content))
			return wsAttachmentChunkReadType, map[string]any{"size": len(content), "dataBase64": base64.StdEncoding.EncodeToString(content[request.Offset:end])}
		},
	})
	var writes sync.Mutex
	written := map[string][]byte{}
	bob := connectFakeDevice(t, live, f.bobDevice, hello("dev_bob", "ws_bob", "/work/bob", nil), map[string]fakeAnswer{
		wsAttachmentWriteType: func(raw json.RawMessage) (string, any) {
			var request wsAttachmentWritePayload
			_ = json.Unmarshal(raw, &request)
			data, _ := base64.StdEncoding.DecodeString(request.DataBase64)
			writes.Lock()
			defer writes.Unlock()
			if request.Abort {
				delete(written, request.RelativePath)
				return wsAttachmentWrittenType, map[string]any{"size": 0}
			}
			if int(request.Offset) != len(written[request.RelativePath]) {
				return wsAttachmentWrittenType, map[string]any{"error": "out of order"}
			}
			written[request.RelativePath] = append(written[request.RelativePath], data...)
			return wsAttachmentWrittenType, map[string]any{"path": "/work/bob/.foundry/attachments/" + request.RelativePath, "size": len(written[request.RelativePath])}
		},
	})
	// What bob's device was told for each path, in order: "write", "publish"
	// (the final chunk) or "abort".
	writeLog := func() map[string][]string {
		steps := map[string][]string{}
		for _, raw := range bob.received(wsAttachmentWriteType) {
			var request wsAttachmentWritePayload
			_ = json.Unmarshal(raw, &request)
			step := "write"
			switch {
			case request.Abort:
				step = "abort"
			case request.Final:
				step = "publish"
			}
			if last := steps[request.RelativePath]; len(last) > 0 && last[len(last)-1] == step {
				continue
			}
			steps[request.RelativePath] = append(steps[request.RelativePath], step)
		}
		return steps
	}
	session, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		AgentID: "agent_ws_alice", WorkspaceID: "ws_alice", Provider: "claude", Prompt: "orchestrate", Source: "chat", CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.server.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.handler, token)

	created, isError := call("create_session", map[string]any{"workspaceId": "ws_bob", "prompt": "read the plan", "attachments": []string{"docs/plan.md", "/work/alice/notes/plan.md"}})
	if isError {
		t.Fatal(created)
	}
	var result struct {
		DeliveredAttachments []deliveredAttachment `json:"deliveredAttachments"`
	}
	if err := json.Unmarshal([]byte(created), &result); err != nil || len(result.DeliveredAttachments) != 2 {
		t.Fatalf("create_session result names no delivered paths: %s", created)
	}
	delivered := result.DeliveredAttachments
	folder := filepath.Dir(delivered[0].Path)
	if !strings.HasPrefix(folder, "/work/bob/.foundry/attachments/") || !strings.HasPrefix(filepath.Base(folder), "att_") ||
		delivered[0].Path != folder+"/plan.md" || delivered[1].Path != folder+"/plan-2.md" || delivered[1].Name != "plan-2.md" {
		t.Fatalf("delivered = %+v, want plan.md and plan-2.md under their own names in one folder", delivered)
	}
	relativePath := strings.TrimPrefix(delivered[0].Path, "/work/bob/.foundry/attachments/")
	writes.Lock()
	if string(written[relativePath]) != string(content) {
		t.Fatalf("bob's device received %d bytes, want %d", len(written[relativePath]), len(content))
	}
	writes.Unlock()
	if steps := writeLog()[relativePath]; !slices.Equal(steps, []string{"write", "publish"}) {
		t.Fatalf("steps for %s = %v, want written unpublished, then published", relativePath, steps)
	}
	publishedAt, dispatchedAt := -1, -1
	bob.mu.Lock()
	for index, request := range bob.requests {
		var write wsAttachmentWritePayload
		if request.Type == wsAttachmentWriteType && json.Unmarshal(request.Payload, &write) == nil && write.Final {
			publishedAt = index
		}
		if request.Type == wsRunSessionType && dispatchedAt < 0 {
			dispatchedAt = index
		}
	}
	bob.mu.Unlock()
	if publishedAt < 0 || dispatchedAt < publishedAt {
		t.Fatalf("published at request %d, dispatched at %d: files must be published before the session runs", publishedAt, dispatchedAt)
	}
	var reads []wsAttachmentReadPayload
	for _, raw := range alice.received(wsAttachmentReadType) {
		var request wsAttachmentReadPayload
		_ = json.Unmarshal(raw, &request)
		reads = append(reads, request)
	}
	if len(reads) != 4 || reads[0].Path != "/work/alice/docs/plan.md" || reads[1].Offset != attachmentChunkBytes || reads[0].MaxBytes != maxMCPAttachmentBytes ||
		reads[2].Path != "/work/alice/notes/plan.md" {
		t.Fatalf("reads on alice's device = %+v", reads)
	}
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	for deadline := time.Now().Add(5 * time.Second); run.Session.Input.Prompt != "read the plan"; {
		for _, raw := range bob.received(wsRunSessionType) {
			_ = json.Unmarshal(raw, &run)
		}
		if time.Now().After(deadline) {
			t.Fatalf("bob's device got no run_session for the child")
		}
		time.Sleep(10 * time.Millisecond)
	}
	attachments := run.Session.Input.Attachments
	if len(attachments) != 2 || attachments[0].Name != "plan.md" || attachments[0].Path != delivered[0].Path ||
		attachments[0].Size != int64(len(content)) || attachments[0].Kind != "file" || attachments[0].MIMEType == "" ||
		attachments[0].ID != delivered[0].ID || !strings.HasPrefix(attachments[0].ID, filepath.Base(folder)+"_") {
		t.Fatalf("the child's input attachments = %+v", attachments)
	}

	// A create the store refuses after the files were written leaves none
	// behind: they were never published, and are dropped.
	if text, isError := call("create_session", map[string]any{"workspaceId": "ws_bob", "prompt": "x", "issueId": "iss_missing", "attachments": []string{"docs/plan.md"}}); !isError {
		t.Fatalf("create_session in a missing Issue = %q", text)
	}
	refused := 0
	for path, steps := range writeLog() {
		if path == relativePath || strings.HasSuffix(path, "/plan-2.md") {
			continue
		}
		refused++
		if !slices.Equal(steps, []string{"write", "abort"}) {
			t.Fatalf("steps for %s of a refused create = %v, want written, then dropped", path, steps)
		}
	}
	if refused != 1 {
		t.Fatalf("a refused create wrote %d files, want 1 dropped: %v", refused, writeLog())
	}

	// A message to an idle session delivers its files the same way.
	idle, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		AgentID: "agent_ws_bob", WorkspaceID: "ws_bob", Provider: "claude", Prompt: "earlier", Source: "agent", ParentSessionID: session.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.CompleteAgentSession(ctx, idle.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	sent, isError := call("send_message", map[string]any{"sessionId": idle.ID, "prompt": "and this", "attachments": []string{"docs/plan.md"}})
	result.DeliveredAttachments = nil
	if isError || json.Unmarshal([]byte(sent), &result) != nil || len(result.DeliveredAttachments) != 1 {
		t.Fatalf("send_message result names no delivered paths: %s", sent)
	}
	again := result.DeliveredAttachments[0]
	if filepath.Base(again.Path) != "plan.md" || filepath.Dir(again.Path) == folder {
		t.Fatalf("a message's file = %+v, want plan.md in a folder of its own", again)
	}
	if steps := writeLog()[strings.TrimPrefix(again.Path, "/work/bob/.foundry/attachments/")]; !slices.Equal(steps, []string{"write", "publish"}) {
		t.Fatalf("steps for a message's file = %v, want written, then published", steps)
	}

	if text, isError := call("send_message", map[string]any{"sessionId": run.Session.ID, "prompt": "and this", "attachments": []string{"/etc/passwd"}}); !isError || !strings.Contains(text, "/etc/passwd: file is outside the workspace") {
		t.Fatalf("a file outside the workspace = %q", text)
	}
	if text, isError := call("create_session", map[string]any{"workspaceId": "ws_bob", "prompt": "x", "attachments": []string{"att_unknown"}}); !isError || !strings.Contains(text, "no attachment att_unknown among those your session was given") {
		t.Fatalf("an unknown attachment id = %q", text)
	}
	tooMany := make([]string, maxMCPAttachments+1)
	for index := range tooMany {
		tooMany[index] = "docs/plan.md"
	}
	if text, isError := call("create_session", map[string]any{"workspaceId": "ws_bob", "prompt": "x", "attachments": tooMany}); !isError || !strings.Contains(text, "at most 10 attachments") {
		t.Fatalf("too many attachments = %q", text)
	}

	// A device whose worker cannot read workspace files says so.
	_ = connectFakeDevice(t, live, f.aliceDevice, hello("dev_alice", "ws_alice", "/work/alice", nil), nil)
	if text, isError := call("create_session", map[string]any{"workspaceId": "ws_bob", "prompt": "x", "attachments": []string{"docs/plan.md"}}); !isError || !strings.Contains(text, "runs an older worker, which cannot hand files over") {
		t.Fatalf("an older worker = %q", text)
	}
}
