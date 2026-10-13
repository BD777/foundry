package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// list_issues and get_issue read the Issues of the workspaces a session
// reaches; a session working in an Issue sees only that one, and they
// change nothing.
func TestIssueToolsReadIssuesWithinReach(t *testing.T) {
	db, chat := lineageFixture(t)
	ctx := context.Background()
	handler := NewServer(db).Routes()
	mint := func(sessionID string) string {
		t.Helper()
		token, err := db.MintAgentSessionToken(ctx, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	drafted, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_lineage", Title: "Friendlier greeting", SourceInput: "make the greeting friendlier", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	executed, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_lineage", Title: "Deploy", SourceInput: "deploy the site", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, executed.ID)
	_, execution, err := db.ClaimIssueExecution(ctx, "dev_lineage", "ws_lineage")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartIssueRun(ctx, executed.ID, store.Run{ID: execution.ID, IssueID: executed.ID, Runtime: "claude"}); err != nil {
		t.Fatal(err)
	}

	call := mcpToolCaller(t, handler, mint(chat.ID))
	listed, isError := call("list_issues", map[string]any{})
	if isError {
		t.Fatal(listed)
	}
	var page struct {
		Issues []mcpIssueItem `json:"issues"`
	}
	if err := json.Unmarshal([]byte(listed), &page); err != nil || len(page.Issues) != 2 {
		t.Fatalf("list_issues = %s", listed)
	}
	if strings.Count(listed, "\n    {") != 2 {
		t.Fatalf("one Issue per line: %s", listed)
	}
	byID := map[string]mcpIssueItem{}
	for _, item := range page.Issues {
		byID[item.ID] = item
	}
	if item := byID[executed.ID]; item.Status != "in_progress" || item.Contract != "confirmed r2" || item.Run != "running" {
		t.Fatalf("the executed Issue's line = %+v", item)
	}
	if item := byID[drafted.ID]; item.Status != "pending" || item.Contract != "draft (draft r1)" || item.Run != "" {
		t.Fatalf("the drafted Issue's line = %+v", item)
	}
	filtered, _ := call("list_issues", map[string]any{"status": []string{"in_progress"}})
	if !strings.Contains(filtered, executed.ID) || strings.Contains(filtered, drafted.ID) {
		t.Fatalf("status filter = %s", filtered)
	}

	got, isError := call("get_issue", map[string]any{"issueId": executed.ShortID})
	if isError {
		t.Fatal(got)
	}
	var view mcpIssueView
	if err := json.Unmarshal([]byte(got), &view); err != nil {
		t.Fatal(err)
	}
	if view.ID != executed.ID || view.Contract == nil || view.Contract.Revision != 2 || view.Contract.Status != "confirmed" ||
		len(view.Contract.Criteria) != 1 || view.Contract.Criteria[0].ID != "criterion_output" || !view.Contract.Criteria[0].Required ||
		view.Run == nil || view.Run.SessionID != execution.ID || view.Request != "deploy the site" || view.DraftRevision != nil {
		t.Fatalf("get_issue = %s", got)
	}
	draftView, _ := call("get_issue", map[string]any{"issueId": drafted.ID})
	if !strings.Contains(draftView, `"contractState": "draft"`) || !strings.Contains(draftView, `"revision": 1`) {
		t.Fatalf("a drafted Issue shows its draft: %s", draftView)
	}
	if text, isError := call("get_issue", map[string]any{"issueId": "iss_missing"}); !isError || !strings.Contains(text, "no Issue iss_missing that you can read") {
		t.Fatalf("a missing Issue = %q", text)
	}
	if text, isError := call("list_issues", map[string]any{"workspaceId": "ws_elsewhere"}); !isError || text != "workspace not found" {
		t.Fatalf("an unreachable workspace = %q", text)
	}

	// The execution works in its Issue: it sees that Issue alone.
	confined := mcpToolCaller(t, handler, mint(execution.ID))
	if text, _ := confined("list_issues", map[string]any{}); !strings.Contains(text, executed.ID) || strings.Contains(text, drafted.ID) {
		t.Fatalf("an Issue's session lists %s", text)
	}
	if text, isError := confined("get_issue", map[string]any{"issueId": drafted.ID}); !isError || !strings.Contains(text, "no Issue") {
		t.Fatalf("an Issue's session reads another Issue: %q", text)
	}
}

// A verifier sees and calls only the tools that change nothing, and one is
// refused on a device whose worker cannot sandbox its commands.
func TestVerifierToolsAndDevice(t *testing.T) {
	db, chat := lineageFixture(t)
	ctx := context.Background()
	server := NewServer(db)
	handler := server.Routes()
	live := httptest.NewServer(handler)
	defer live.Close()
	verifier, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "check the change", Source: "verification", ParentSessionID: chat.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verifier.ClaudePermissionMode != "dontAsk" || verifier.CodexSandboxMode != "danger-full-access" || verifier.CodexApprovalPolicy != "never" {
		t.Fatalf("a verifier's runtime = %q / %q", verifier.ClaudePermissionMode, verifier.CodexSandboxMode)
	}
	token, err := db.MintAgentSessionToken(ctx, verifier.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{}
	for _, tool := range remoteMCPTools {
		if tool.readOnly {
			want = append(want, tool.name)
		}
	}
	for _, name := range []string{"read_context", "list_issues", "get_issue", "wait_session"} {
		if !slices.Contains(want, name) {
			t.Fatalf("%s is not marked read-only", name)
		}
	}
	for _, name := range []string{"create_session", "send_message", "cancel_session", "rename_session", "handoff_session", "ask_person"} {
		if slices.Contains(want, name) {
			t.Fatalf("%s is marked read-only", name)
		}
	}
	if names := mcpToolNames(t, handler, token); !slices.Equal(names, want) {
		t.Fatalf("a verifier sees %v, want %v", names, want)
	}
	call := mcpToolCaller(t, handler, token)
	if text, isError := call("create_session", map[string]any{"prompt": "fix it"}); !isError || !strings.Contains(text, "create_session is not available to a verifier") {
		t.Fatalf("a verifier starting a session = %q", text)
	}
	if text, isError := call("read_context", map[string]any{"sessionId": chat.ID}); isError || !strings.Contains(text, chat.ID) {
		t.Fatalf("a verifier reading a session = %q", text)
	}

	chatToken, err := db.MintAgentSessionToken(ctx, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	orchestrator := mcpToolCaller(t, handler, chatToken)
	connect := func(capabilities []string) *websocket.Conn {
		t.Helper()
		conn := dialDaemonForTest(t, live)
		writeWSForTest(t, conn, "hello", lineageHello(capabilities))
		readWSTypeForTest(t, conn, "registered")
		return conn
	}
	older := connect([]string{})
	if text, isError := orchestrator("create_session", map[string]any{"prompt": "check", "verification": true}); !isError || !strings.Contains(text, "Studio runs an older worker") {
		t.Fatalf("a verifier on an older worker = %q", text)
	}
	older.Close()
	current := connect([]string{store.DaemonCapabilityVerificationSessions})
	text, isError := orchestrator("create_session", map[string]any{"prompt": "check", "verification": true})
	if isError || !strings.Contains(text, `"source": "verification"`) {
		t.Fatalf("a verifier on a current worker = %q", text)
	}
	var run struct {
		Session store.AgentSession `json:"session"`
	}
	// The queued chat is dispatched on connect too.
	for run.Session.Source != "verification" {
		readWSUntilForTest(t, current, "run_session", &run)
	}
	if run.Session.Source != "verification" || run.Session.ClaudePermissionMode != "dontAsk" || run.Session.ParentSessionID != chat.ID {
		t.Fatalf("dispatched verifier = %+v", run.Session)
	}
}

// lineageHello is lineageFixture's device saying hello with capabilities.
func lineageHello(capabilities []string) map[string]any {
	return map[string]any{
		"capabilities":     capabilities,
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_lineage", "label": "Studio", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_lineage", "name": "Foundry", "localPath": "/work/foundry"},
		"agents": []map[string]any{{
			"id": "agent_lineage", "workspaceId": "ws_lineage", "deviceId": "dev_lineage", "provider": "claude",
			"status": "healthy", "authMode": "local_config", "secretStored": "local", "configScope": "workspace",
			"configLabel": "local", "lastSeenLabel": "online",
		}},
	}
}
