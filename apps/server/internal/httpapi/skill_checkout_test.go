package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func TestCheckoutSkillRecordsAcknowledgedLibraryRevision(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	source := store.PromoteSkillInput{DeviceID: "dev_alice", Root: "/library", DirName: "demo"}
	var skill store.PromotedSkill
	for _, body := range []string{"first", "second"} {
		archive, _ := comparisonArchive(t, map[string]string{"SKILL.md": "---\nname: demo\n---\n" + body})
		var err error
		skill, _, err = f.db.AddPromotedSkillRevision(ctx, source, "demo", "", archive, 1)
		if err != nil {
			t.Fatal(err)
		}
	}
	token := skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	reader := skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceAccess: store.SessionWorkspaceAccessRead})
	live := httptest.NewServer(f.handler)
	defer live.Close()
	issue, err := f.db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", Title: "checkout", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, f.db, issue.ID)
	_, execution, err := f.db.ClaimIssueExecution(ctx, "dev_alice", "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	issueToken, err := f.db.MintAgentSessionToken(ctx, execution.ID)
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": []string{workspaceSkillCheckoutCapability, "issue_skill_checkout"},
		"device":       map[string]any{"id": "dev_alice", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/ws_alice"},
	}, map[string]fakeAnswer{wsCheckoutWorkspaceSkillType: func(raw json.RawMessage) (string, any) {
		requests++
		var msg wsCheckoutWorkspaceSkillPayload
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Error(err)
		}
		if requests == 3 {
			if msg.IssueID != issue.ID || msg.WorkspaceID != "ws_alice" || msg.Ref.Revision != 2 {
				t.Errorf("wrong candidate checkout: %+v", msg)
			}
			return wsWorkspaceSkillCheckedOutType, wsWorkspaceSkillCheckedOut{DirectoryID: "candidate"}
		}
		if msg.IssueID != "" || msg.WorkspaceID != "ws_alice" || msg.Ref.SkillID != skill.ID || msg.Ref.Revision != requests || msg.Ref.Checksum == "" {
			t.Errorf("wrong checkout request: %+v", msg)
		}
		if requests > 1 {
			return wsWorkspaceSkillCheckedOutType, wsReplyError{Error: "target exists"}
		}
		return wsWorkspaceSkillCheckedOutType, wsWorkspaceSkillCheckedOut{DirectoryID: "identity"}
	}})
	args := map[string]any{"workspaceId": "ws_alice", "skillId": skill.ID, "revision": 1}
	if text, failed := mcpToolCaller(t, f.handler, reader)("checkout_skill", args); !failed {
		t.Fatalf("read-only checkout succeeded: %s", text)
	}
	call := mcpToolCaller(t, f.handler, token)
	text, failed := call("checkout_skill", args)
	if failed {
		t.Fatal(text)
	}
	var result checkedOutSkill
	if err := json.Unmarshal([]byte(text), &result); err != nil || result.Revision != 1 || result.RelativePath != ".agents/skills/demo" {
		t.Fatalf("checkout result %q: %v", text, err)
	}
	delete(args, "revision")
	if text, failed = call("checkout_skill", args); !failed || !strings.Contains(text, "target exists") {
		t.Fatalf("existing checkout: %s", text)
	}
	issueCall := mcpToolCaller(t, f.handler, issueToken)
	if text, failed := issueCall("checkout_skill", map[string]any{"workspaceId": "ws_bob", "skillId": skill.ID}); !failed {
		t.Fatalf("cross-workspace checkout: %s", text)
	}
	if text, failed := issueCall("checkout_skill", args); failed {
		t.Fatalf("Issue candidate checkout: %s", text)
	}
	bases, err := f.db.WorkspaceSkillCheckouts(ctx, "ws_alice")
	if err != nil || len(bases) != 1 || bases[result.RelativePath] != (store.SkillCheckoutBaseline{SkillID: skill.ID, Revision: 1, CheckoutDirectoryID: "identity"}) {
		t.Fatalf("saved baselines: %+v, %v", bases, err)
	}
}

func TestDraftScanRecoversLostCheckoutAcknowledgement(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	const ws = "ws_alice"
	const path = ".agents/skills/demo"
	draft := store.WorkspaceDraftSkill{ID: "draft", WorkspaceID: ws, ExecutionRootID: ws, RelativePath: path}
	origin := store.SkillCheckoutOrigin{SkillCheckoutBaseline: store.SkillCheckoutBaseline{SkillID: "demo", Revision: 1}, DirectoryID: "inode:created"}
	scan := store.WorkspaceDraftSkills{Enabled: true, Skills: []store.WorkspaceDraftSkill{draft}, CheckoutOrigins: map[string]store.SkillCheckoutOrigin{path: origin}}
	verifyScan := func(want int) {
		t.Helper()
		if err := f.server.store.SaveWorkspaceDrafts(ctx, ws, ws, scan); err != nil {
			t.Fatal(err)
		}
		bases, err := f.server.store.WorkspaceSkillCheckouts(ctx, ws)
		if err != nil || bases[path].Revision != want {
			t.Fatalf("baselines=%v, err=%v, wanted %d", bases, err, want)
		}
	}
	verifyScan(1)
	if err := f.server.store.SaveWorkspaceSkillCheckout(ctx, ws, path, store.SkillCheckoutBaseline{SkillID: "demo", Revision: 2}); err != nil {
		t.Fatal(err)
	}
	verifyScan(2)
	// Recreated at the same path with no matching inode receipt.
	delete(scan.CheckoutOrigins, path)
	verifyScan(0)
	// A baseline set by publishing a fresh draft disappears when that draft does.
	if err := f.server.store.SaveWorkspaceSkillCheckout(ctx, ws, path, store.SkillCheckoutBaseline{SkillID: "demo", Revision: 3}); err != nil {
		t.Fatal(err)
	}
	scan.Skills = nil
	verifyScan(0)
}
