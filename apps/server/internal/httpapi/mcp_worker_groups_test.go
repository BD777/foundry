package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's chat switches a worker group's members to another runtime,
// as the page's editor does: the group keeps its id, label and creation
// time, efforts are checked per runtime, and another person's group is
// not found.
func TestWorkerGroupsToolSwitchesMembersLikeThePage(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	codex := saveLearningProfile(t, f)
	claude, err := f.db.SaveProfile(ctx, store.SaveProfileInput{
		ID: "provider_worker_claude", Runtime: "claude", Label: "Worker relay (Claude)",
		AuthMode: "custom", ConnectionType: "anthropic_compatible",
		BaseURL: "https://worker.example", Model: "cheap-worker",
		Models: []string{"cheap-worker", "cheap-worker-fast"}, OwnerUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})

	var created store.WorkerGroup
	alice.ok("worker_groups", `{"action":"save","label":"cheap","members":[`+
		`{"providerKind":"api","providerId":"`+codex.ID+`","runtime":"codex","model":"cheap-worker","effort":"xhigh","tokensPerMinute":1000000,"weight":1}]}`, &created)
	if created.ID == "" || created.Label != "cheap" || len(created.Members) != 1 {
		t.Fatalf("created = %+v", created)
	}
	stored, err := f.db.GetWorkerGroup(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}

	if text, failed, _ := alice.call("worker_groups", `{"action":"save","id":"`+created.ID+`","members":[`+
		`{"providerKind":"api","providerId":"`+codex.ID+`","runtime":"claude","model":"cheap-worker"}]}`); !failed || !strings.Contains(text, "not found") {
		t.Fatalf("a member whose runtime is not its provider's = %q", text)
	}
	if text, failed, _ := alice.call("worker_groups", `{"action":"save","id":"`+created.ID+`","members":[`+
		`{"providerKind":"api","providerId":"`+claude.ID+`","runtime":"claude","model":"cheap-worker","effort":"minimal"}]}`); !failed || !strings.Contains(text, "effort") {
		t.Fatalf("a Codex-only effort on Claude = %q", text)
	}

	var switched store.WorkerGroup
	alice.ok("worker_groups", `{"action":"save","id":"`+created.ID+`","members":[`+
		`{"providerKind":"api","providerId":"`+claude.ID+`","runtime":"claude","model":"cheap-worker","effort":"xhigh","tokensPerMinute":1000000,"weight":1},`+
		`{"providerKind":"api","providerId":"`+claude.ID+`","runtime":"claude","model":"cheap-worker-fast","effort":"xhigh","tokensPerMinute":6000000,"weight":1}]}`, &switched)
	if switched.ID != created.ID || switched.Label != "cheap" || len(switched.Members) != 2 ||
		switched.Members[1].ProviderID != claude.ID || switched.Members[1].TokensPerMinute != 6_000_000 {
		t.Fatalf("switched = %+v", switched)
	}
	if after, err := f.db.GetWorkerGroup(ctx, created.ID); err != nil || after.OwnerUserID != f.aliceID || after.CreatedAt != stored.CreatedAt {
		t.Fatalf("after = %+v %v; want the owner and creation time kept", after, err)
	}

	var listed struct {
		Groups []store.WorkerGroup `json:"groups"`
	}
	alice.ok("worker_groups", `{"action":"list"}`, &listed)
	if len(listed.Groups) != 1 || listed.Groups[0].Members[0].Runtime != "claude" {
		t.Fatalf("listed = %+v", listed)
	}

	bob := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.bobID, AgentID: "agent_bob", WorkspaceID: "ws_bob"})
	if text, failed, _ := bob.call("worker_groups", `{"action":"save","id":"`+created.ID+`","label":"mine"}`); !failed || !strings.Contains(text, "not found") {
		t.Fatalf("another person's group = %q", text)
	}
}
