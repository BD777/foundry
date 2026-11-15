package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// digestDaemon plays the assistant's home device: it answers file reads
// and hands over the summary sessions it is given.
type digestDaemon struct {
	ignoreCancel atomic.Bool
	// closing: the test is ending and closes the socket.
	closing        atomic.Bool
	t              *testing.T
	conn           *websocket.Conn
	writeMu        sync.Mutex
	runs           chan wsRunSessionPayload
	instructionsMu sync.RWMutex
	instructions   map[string]string
	filesMu        sync.Mutex
	files          map[string]string
}

func (d *digestDaemon) setInstruction(path, content string) {
	d.instructionsMu.Lock()
	defer d.instructionsMu.Unlock()
	d.instructions[path] = content
}

func (d *digestDaemon) instruction(path string) (string, bool) {
	d.instructionsMu.RLock()
	defer d.instructionsMu.RUnlock()
	content, ok := d.instructions[path]
	return content, ok
}

func (d *digestDaemon) write(id, messageType string, payload any) {
	d.t.Helper()
	if err := d.send(id, messageType, payload); err != nil {
		d.t.Fatalf("write websocket %s: %v", messageType, err)
	}
}

func (d *digestDaemon) send(id, messageType string, payload any) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	return d.conn.WriteJSON(map[string]any{"id": id, "payload": payload, "type": messageType})
}

func connectDigestDaemon(t *testing.T, live *httptest.Server) *digestDaemon {
	t.Helper()
	conn := dialDaemonForTest(t, live)
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities":     []string{"role_run_budgets_v1", "exact_input_cancel_v1", "context_files_v1", store.DaemonCapabilityWorkspaceFileWrite, store.DaemonCapabilityWorkspaceFileManage},
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_home", "label": "MacBook", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_pa", "name": "Assistant", "localPath": "/home/me/Foundry/personal-agent"},
		"agents": []map[string]any{{
			"id": "agent_pa", "workspaceId": "ws_pa", "deviceId": "dev_home", "provider": "claude",
			"status": "healthy", "authMode": "local_config", "secretStored": "local", "configScope": "workspace",
			"configLabel": "local", "lastSeenLabel": "online",
		}},
	})
	readWSTypeForTest(t, conn, "registered")
	daemon := &digestDaemon{t: t, conn: conn, runs: make(chan wsRunSessionPayload, 8), instructions: map[string]string{}, files: map[string]string{}}
	// Runs before dialDaemonForTest's cleanup closes the socket.
	t.Cleanup(func() { daemon.closing.Store(true) })
	answer := func(id, messageType string, payload any) bool {
		err := daemon.send(id, messageType, payload)
		if err != nil && !daemon.closing.Load() {
			t.Errorf("write websocket %s: %v", messageType, err)
		}
		return err == nil
	}
	go func() {
		for {
			var envelope struct {
				ID      string          `json:"id"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := conn.ReadJSON(&envelope); err != nil {
				return
			}
			switch envelope.Type {
			case wsReadFileType:
				var read wsReadFilePayload
				_ = json.Unmarshal(envelope.Payload, &read)
				content := "# Budget\n\nTracks the family's spending by month.\n\nRun `make`.\n"
				if instruction, ok := daemon.instruction(read.Path); ok {
					content = instruction
				}
				// A read the server asks for as the test ends may meet the
				// socket closed: nothing is left to answer.
				if !answer(envelope.ID, wsFileReadType, map[string]any{
					"workspaceId": read.WorkspaceID, "path": read.Path,
					"content": content,
				}) {
					return
				}
			case wsListWorkspaceTreeType:
				var request wsListWorkspaceTreePayload
				_ = json.Unmarshal(envelope.Payload, &request)
				if !answer(envelope.ID, wsWorkspaceTreeListedType, wsWorkspaceTreeListedPayload{
					WorkspaceID: request.WorkspaceID, Path: request.Path, Entries: daemon.tree(request.WorkspaceID, request.Path),
				}) {
					return
				}
			case wsWriteFileType:
				var request wsWriteFilePayload
				_ = json.Unmarshal(envelope.Payload, &request)
				daemon.filesMu.Lock()
				daemon.files[workspaceFilePath(request.WorkspaceID, request.Path)] = request.Content
				daemon.filesMu.Unlock()
				if !answer(envelope.ID, wsFileWrittenType, wsFileWrittenPayload{
					WorkspaceID: request.WorkspaceID, Path: request.Path, Sha256: contentSha256(request.Content), Bytes: len(request.Content),
				}) {
					return
				}
			case wsManageFileType:
				var request wsManageFilePayload
				_ = json.Unmarshal(envelope.Payload, &request)
				daemon.filesMu.Lock()
				delete(daemon.files, workspaceFilePath(request.WorkspaceID, request.Path))
				daemon.filesMu.Unlock()
				if !answer(envelope.ID, wsFileManagedType, wsFileManagedPayload{
					WorkspaceID: request.WorkspaceID, Op: request.Op, Path: request.Path, ToPath: request.ToPath,
				}) {
					return
				}
			case wsCancelSessionType:
				if daemon.ignoreCancel.Load() {
					continue
				}
				var cancel wsCancelSessionPayload
				_ = json.Unmarshal(envelope.Payload, &cancel)
				if !answer(envelope.ID, wsSessionCanceledType, map[string]any{"sessionId": cancel.SessionID, "inputId": cancel.InputID, "stopped": true}) {
					return
				}
			case wsRunSessionType:
				var run wsRunSessionPayload
				if json.Unmarshal(envelope.Payload, &run) == nil {
					daemon.runs <- run
				}
			}
		}
	}()
	return daemon
}

// workspaceFilePath keys a daemon's files by the workspace they belong to:
// the assistant's home and its channel workspaces share one device.
func workspaceFilePath(workspaceID, path string) string {
	return workspaceID + "\x00" + path
}

// tree lists the summary files the daemon holds in workspace under path.
func (d *digestDaemon) tree(workspaceID, path string) []store.WorkspaceTreeEntry {
	d.filesMu.Lock()
	defer d.filesMu.Unlock()
	if path != workspacedigest.ProjectFilesDir {
		return nil
	}
	prefix := workspaceFilePath(workspaceID, workspacedigest.ProjectFilesDir+"/")
	entries := []store.WorkspaceTreeEntry{}
	for file := range d.files {
		name, ok := strings.CutPrefix(file, prefix)
		if ok && !strings.Contains(name, "/") && strings.HasSuffix(name, ".md") {
			entries = append(entries, store.WorkspaceTreeEntry{Name: name, Path: workspacedigest.ProjectFilesDir + "/" + name})
		}
	}
	return entries
}

// workspaceFiles are workspace's files, by path.
func (d *digestDaemon) workspaceFiles(workspaceID string) map[string]string {
	d.filesMu.Lock()
	defer d.filesMu.Unlock()
	prefix := workspaceID + "\x00"
	out := map[string]string{}
	for key, content := range d.files {
		if path, ok := strings.CutPrefix(key, prefix); ok {
			out[path] = content
		}
	}
	return out
}

func (d *digestDaemon) nextRun() wsRunSessionPayload {
	d.t.Helper()
	select {
	case run := <-d.runs:
		return run
	case <-time.After(5 * time.Second):
		d.t.Fatal("no summary session reached the device")
		return wsRunSessionPayload{}
	}
}

func (d *digestDaemon) complete(session store.AgentSession, response string) {
	d.write("test_"+wsSessionCompleteType, wsSessionCompleteType, map[string]any{
		"sessionId": session.ID, "inputId": session.Input.ID, "response": response, "nativeSessionId": "native_" + session.ID,
	})
}

type digestFixture struct {
	server  *Server
	db      *sqlitestore.Store
	daemon  *digestDaemon
	aliceID string
	// live serves the server; a test that drops the device reconnects to it.
	live *httptest.Server
}

// newDigestFixture: alice's assistant lives in ws_pa on dev_home; her
// project ws_budget is on the same device.
func newDigestFixture(t *testing.T) digestFixture {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := NewServer(db)
	// The device's hello starts work of its own (digest refreshes, reads of
	// instruction files). It runs to its end before the fixture adds what
	// tests look at, or a late one would rewrite digests a test changed or
	// read files from a device the test is closing.
	connected, helloHandled := server.hub.onDeviceConnected, make(chan struct{})
	var handledOnce sync.Once
	server.hub.onDeviceConnected = func(ctx context.Context, deviceID string) {
		connected(ctx, deviceID)
		handledOnce.Do(func() { close(helloHandled) })
	}
	live := serveForTest(t, server)
	daemon := connectDigestDaemon(t, live)
	select {
	case <-helloHandled:
	case <-time.After(5 * time.Second):
		t.Fatal("the device's hello was never handled")
	}
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:         store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace:      store.WorkspaceProjection{ID: "ws_budget", Name: "Budget", LocalPath: "/home/me/budget"},
		WorkspaceFiles: []store.WorkspaceFileEntry{{ID: "f1", WorkspaceID: "ws_budget", Path: "README.md", Name: "README.md", Kind: "file", SizeLabel: "1 KB"}},
		Agents: []store.AgentProjection{{
			ID: "agent_budget", WorkspaceID: "ws_budget", DeviceID: "dev_home", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	alice, err := db.CreateUser(ctx, store.NewUser{Username: "alice", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	for _, workspaceID := range []string{"ws_pa", "ws_budget"} {
		if err := db.SetWorkspaceMember(ctx, workspaceID, alice.ID, store.WorkspaceRoleOwner, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: alice.ID, WorkspaceID: "ws_pa", HomeDeviceID: "dev_home", Settings: personalagent.DefaultSettings()}); err != nil {
		t.Fatal(err)
	}
	return digestFixture{server: server, db: db, daemon: daemon, aliceID: alice.ID, live: live}
}

func (f digestFixture) digest(t *testing.T) store.WorkspaceDigestRecord {
	t.Helper()
	if _, err := f.server.workspaceDigests().Digest(context.Background(), f.aliceID, "ws_budget"); err != nil {
		t.Fatal(err)
	}
	records, err := f.db.ListWorkspaceDigests(context.Background(), f.aliceID)
	if err != nil || len(records) != 1 {
		t.Fatalf("digests = %+v, %v", records, err)
	}
	return records[0]
}

// A digest change updates the assistant's project summary files: Foundry
// writes them into its home, and removes the one of an archived project.
func TestAssistantProjectFilesFollowTheDigest(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.WriteProjectFiles(ctx, agent); err != nil {
		t.Fatal(err)
	}
	files := f.daemon.workspaceFiles("ws_pa")
	summary := files[workspacedigest.ProjectFilesDir+"/budget.md"]
	if !strings.Contains(summary, "ws_budget") || !strings.Contains(summary, "Budget") {
		t.Fatalf("project summary = %q", summary)
	}
	if manifest := files[workspacedigest.ProjectManifestPath]; !strings.Contains(manifest, "budget.md") {
		t.Fatalf("manifest = %q", manifest)
	}
	if _, err := f.db.SetWorkspaceArchived(ctx, "ws_budget", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.WriteProjectFiles(ctx, agent); err != nil {
		t.Fatal(err)
	}
	files = f.daemon.workspaceFiles("ws_pa")
	if _, ok := files[workspacedigest.ProjectFilesDir+"/budget.md"]; ok {
		t.Fatalf("an archived project kept its summary: %+v", files)
	}
	if manifest := files[workspacedigest.ProjectManifestPath]; strings.Contains(manifest, "budget.md") {
		t.Fatalf("manifest kept an archived project: %q", manifest)
	}
}

// A message channel's workspace gets the same project index and summary
// files as the assistant's home (routing reads them from a channel too),
// and a digest change refreshes the index there as well.
func TestAssistantProjectFilesReachAChannelWorkspace(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "MacBook", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_channel", Name: "Assistant · messages", LocalPath: "/home/me/message-channel-mch_1"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceMember(ctx, "ws_channel", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SaveMessageChannel(ctx, store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{
		ID: "mch_1", AssistantID: agent.ID, WorkspaceID: "ws_channel", Name: "Lark /fd", Enabled: true, SessionKey: "conversation",
		Source:    store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_lark"},
		CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.WriteProjectFiles(ctx, agent); err != nil {
		t.Fatal(err)
	}
	home := f.daemon.workspaceFiles("ws_pa")
	channel := f.daemon.workspaceFiles("ws_channel")
	if _, ok := channel[".foundry/projects/budget.md"]; !ok {
		t.Fatalf("the channel workspace lacks the project summary: %+v", channel)
	}
	if _, ok := channel["AGENTS.md"]; ok {
		t.Fatal("the channel workspace's AGENTS.md is the person's, not Foundry's")
	}
	if home[prompt.ProjectIndexPath] == "" || home[prompt.ProjectIndexPath] != channel[prompt.ProjectIndexPath] {
		t.Fatalf("the channel's index differs from the home's: %q / %q", home[prompt.ProjectIndexPath], channel[prompt.ProjectIndexPath])
	}
	if !strings.Contains(channel[prompt.ProjectIndexPath], "Budget") {
		t.Fatalf("the channel's index names no project: %q", channel[prompt.ProjectIndexPath])
	}
	// A digest change refreshes the index where the channel's sessions read it.
	if _, err := f.db.RenameWorkspace(ctx, "ws_budget", "Household budget"); err != nil {
		t.Fatal(err)
	}
	if err := f.server.assistant.WriteProjectFiles(ctx, agent); err != nil {
		t.Fatal(err)
	}
	channel = f.daemon.workspaceFiles("ws_channel")
	if index := channel[prompt.ProjectIndexPath]; !strings.Contains(index, "Household budget") {
		t.Fatalf("the channel's index after a digest change: %q", index)
	}
}

// The summary loop end to end: a new digest is summarized at once by a
// read-only session without Foundry tools in the assistant's workspace;
// its answer is the summary unless it is not the JSON asked for.
func TestWorkspaceDigestSummarySessions(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	digest, err := f.server.workspaceDigests().Digest(ctx, f.aliceID, "ws_budget")
	if err != nil || digest.WorkspaceID != "ws_budget" || !workspacedigest.Stale(digest, time.Now()) {
		t.Fatalf("digest = %+v, %v; want ws_budget, not summarized yet", digest, err)
	}

	run := f.daemon.nextRun()
	session := run.Session
	if session.Source != store.SessionSourceDigest || session.WorkspaceID != "ws_pa" || session.CreatedByUserID != f.aliceID {
		t.Fatalf("summary session = %+v", session)
	}
	if session.ClaudePermissionMode != "dontAsk" || session.CodexSandboxMode != "read-only" || session.CodexApprovalPolicy != "never" {
		t.Fatalf("summary session is not read-only: %+v", session)
	}
	if run.SessionToken != "" || len(run.ExternalAccounts) != 0 || len(run.DeviceConnectors) != 0 {
		t.Fatalf("summary session got Foundry tools or logins: token=%q", run.SessionToken)
	}
	for _, want := range []string{`"name": "Budget"`, "Tracks the family's spending by month.", "Return only JSON"} {
		if !strings.Contains(session.Prompt, want) {
			t.Fatalf("summary prompt misses %q:\n%s", want, session.Prompt)
		}
	}
	if record := f.digest(t); record.Digest.Intro != "Tracks the family's spending by month." || record.SummarySessionID != session.ID {
		t.Fatalf("while summarizing: %+v", record)
	}
	if sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa"); len(sessions) != 1 {
		t.Fatalf("a running summary is listed for reconciling: %+v", sessions)
	}

	f.daemon.complete(session, `{"l0":"记账网页","summary":"记录家庭开销的网页。","routeWhen":["家庭记账"],"notWhen":["报税"]}`)
	record := waitForDigest(t, f, func(record store.WorkspaceDigestRecord) bool { return record.Digest.SummarizedAt != "" })
	if record.Digest.L0 != "记账网页" || record.Digest.Dirty || record.SummaryDueAt != "" || record.Digest.RouteWhen[0] != "家庭记账" {
		t.Fatalf("after the summary: %+v", record)
	}
	if sessions, _ := f.db.ListAgentSessionSummaries(ctx, "ws_pa"); len(sessions) != 0 {
		t.Fatalf("a finished summary is listed among chats: %+v", sessions)
	}

	// A bad answer keeps the summary and tries again later.
	if err := f.db.ScheduleWorkspaceDigestSummary(ctx, f.aliceID, "ws_budget", "2000-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	f.server.runDigestSummaries(ctx, 0)
	again := f.daemon.nextRun().Session
	f.daemon.complete(again, "Sure! This project is a budget page.")
	record = waitForDigest(t, f, func(record store.WorkspaceDigestRecord) bool { return record.SummarySessionID == "" })
	if record.Digest.L0 != "记账网页" {
		t.Fatalf("a bad answer replaced the summary: %+v", record.Digest)
	}
}

func waitForDigest(t *testing.T, f digestFixture, done func(store.WorkspaceDigestRecord) bool) store.WorkspaceDigestRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		record := f.digest(t)
		if done(record) || time.Now().After(deadline) {
			if !done(record) {
				t.Fatalf("digest never settled: %+v", record)
			}
			return record
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// §3's triggers update the right fields: a rename at once and without a
// new summary; a session's end and an Issue's change mark it dirty, due
// after the debounce; losing access deletes it.
func TestWorkspaceDigestTriggers(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	f.digest(t)
	summary := f.daemon.nextRun().Session
	f.daemon.complete(summary, `{"l0":"Budget page","summary":"A budget page.","routeWhen":[],"notWhen":[]}`)
	waitForDigest(t, f, func(record store.WorkspaceDigestRecord) bool { return record.Digest.SummarizedAt != "" })

	if _, err := f.db.RenameWorkspace(ctx, "ws_budget", "Family budget"); err != nil {
		t.Fatal(err)
	}
	if record := f.digest(t); record.Digest.Name != "Family budget" || record.Digest.Dirty {
		t.Fatalf("after a rename: %+v", record.Digest)
	}
	index, err := f.server.workspaceDigests().Index(ctx, f.aliceID)
	if err != nil || !strings.Contains(index, "- 『Family budget』 (ws_budget) · on MacBook · ") || strings.Contains(index, "ws_pa") {
		t.Fatalf("index = %q, %v", index, err)
	}

	chat, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Provider: "claude", Prompt: "Add an Excel export", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	ended, err := f.db.FailAgentSession(ctx, chat.ID, "stopped")
	if err != nil {
		t.Fatal(err)
	}
	f.server.sessions.Changed(ctx, sessions.Completed, ended)
	records, _ := f.db.ListWorkspaceDigests(ctx, f.aliceID)
	if len(records) != 1 || !records[0].Digest.Dirty || len(records[0].Digest.RecentSessions) != 1 || records[0].Digest.RecentSessions[0].Title == "" {
		t.Fatalf("the session's end did not refresh the digest: %+v", records)
	}
	due, _ := time.Parse(time.RFC3339, records[0].SummaryDueAt)
	if until := time.Until(due); until < personalagent.DigestMinInterval-time.Minute {
		t.Fatalf("summary due in %v, want no sooner than 6 h after the last one", until)
	}

	issue, err := f.db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_budget", SourceInput: "Export breaks on empty months", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	f.server.issues.Updated(issue)
	if records, _ := f.db.ListWorkspaceDigests(ctx, f.aliceID); len(records) != 1 || len(records[0].Digest.OpenIssues) != 1 {
		t.Fatalf("the Issue's change did not refresh the digest: %+v", records)
	}

	if err := f.db.RemoveWorkspaceMember(ctx, "ws_budget", f.aliceID); err != nil {
		t.Fatal(err)
	}
	if records, _ := f.db.ListWorkspaceDigests(ctx, f.aliceID); len(records) != 0 {
		t.Fatalf("digest kept after losing access: %+v", records)
	}
	if _, err := f.server.workspaceDigests().Digest(ctx, f.aliceID, "ws_budget"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("digest of a workspace without access: %v", err)
	}
}
