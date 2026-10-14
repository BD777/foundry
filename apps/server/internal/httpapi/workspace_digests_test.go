package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// digestDaemon plays the assistant's home device: it answers file reads
// and hands over the summary sessions it is given.
type digestDaemon struct {
	t       *testing.T
	conn    *websocket.Conn
	writeMu sync.Mutex
	runs    chan wsRunSessionPayload
}

func (d *digestDaemon) write(id, messageType string, payload any) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	writeWSIDForTest(d.t, d.conn, id, messageType, payload)
}

func connectDigestDaemon(t *testing.T, live *httptest.Server) *digestDaemon {
	t.Helper()
	conn := dialDaemonForTest(t, live)
	writeWSForTest(t, conn, "hello", map[string]any{
		"capabilities":     []string{store.DaemonCapabilityWorkspaceCreate},
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
	daemon := &digestDaemon{t: t, conn: conn, runs: make(chan wsRunSessionPayload, 8)}
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
				daemon.write(envelope.ID, wsFileReadType, map[string]any{
					"workspaceId": read.WorkspaceID, "path": read.Path,
					"content": "# Budget\n\nTracks the family's spending by month.\n\nRun `make`.\n",
				})
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
	live := httptest.NewServer(server.Routes())
	t.Cleanup(live.Close)
	daemon := connectDigestDaemon(t, live)
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
	return digestFixture{server: server, db: db, daemon: daemon, aliceID: alice.ID}
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

// The summary loop end to end: a new digest is summarized at once by a
// read-only session without Foundry tools in the assistant's workspace;
// its answer is the summary unless it is not the JSON asked for.
func TestWorkspaceDigestSummarySessions(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	candidates, err := f.server.workspaceDigests().Find(ctx, f.aliceID, "budget", workspacedigest.FindOptions{})
	if err != nil || len(candidates) != 1 || candidates[0].WorkspaceID != "ws_budget" || !candidates[0].Stale {
		t.Fatalf("find = %+v, %v; want only ws_budget, not summarized yet", candidates, err)
	}

	run := f.daemon.nextRun()
	session := run.Session
	if session.Source != store.DigestSessionSource || session.WorkspaceID != "ws_pa" || session.CreatedByUserID != f.aliceID {
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
	f.server.sessions.changed(ctx, sessionCompleted, ended)
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
	f.server.issues.updated(issue)
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
	if candidates, _ := f.server.workspaceDigests().Find(ctx, f.aliceID, "budget", workspacedigest.FindOptions{}); len(candidates) != 0 {
		t.Fatalf("find after losing access = %+v", candidates)
	}
}
