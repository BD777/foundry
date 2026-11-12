package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestModelGuidesHTTPAndMCP(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	profile, err := f.db.SaveProfile(ctx, store.SaveProfileInput{
		ID: "provider_hub", Runtime: "codex", Label: "Hub", AuthMode: "custom", ConnectionType: "openai_compatible",
		BaseURL: "https://hub.example", Model: "flash-1017", Models: []string{"flash-1017"}, OwnerUserID: f.aliceID,
		ContextWindows: map[string]int64{"flash-1017": 256000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Hub flash",
		Members: []store.WorkerGroupMember{{ProviderKind: "api", ProviderID: profile.ID, Runtime: "codex", Model: "flash-1017", TokensPerMinute: 1_000_000}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.RecordUsage(ctx, store.UsageRecord{Requests: []store.UsageRequest{{
		RequestID: "req_1", SessionID: "sess_worker", InputID: "in_1", UserID: f.aliceID, ParentSessionID: "sess_parent",
		Entry: store.UsageEntryChatChild, At: time.Now().UTC().Format(time.RFC3339Nano), Runtime: "codex",
		ProfileID: profile.ID, Model: "flash-1017", OutputTokens: 200, GenerationMs: 2000, RequestMs: 3000,
	}}}); err != nil {
		t.Fatal(err)
	}

	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var resolution store.ModelGuideResolution
	alice.ok("model_guides", `{"action":"resolve","providerKind":"api","providerId":"provider_hub","runtime":"codex","model":"Vendor/Flash-1017"}`, &resolution)
	if resolution.Guide != nil || resolution.SuggestedID != "flash-1017" || resolution.SuggestedIDTaken {
		t.Fatalf("resolve without a guide = %+v", resolution)
	}

	var saved modelGuideSave
	alice.ok("model_guides", `{"action":"upsert","id":"flash-1017","displayName":"Flash","owner":"deepseek","changeSummary":"first guide",
		"sections":{"summary":"Fast and cheap.","briefing":"- Name files.\n- Ask for the diff."},
		"aliases":[{"providerKind":"api","providerId":"provider_hub","runtime":"codex","model":"flash-1017"}]}`, &saved)
	if !saved.Saved || saved.Guide.Revision != 1 || saved.Guide.UpdatedBy.SessionID == "" || saved.Guide.UpdatedBy.UserID != f.aliceID {
		t.Fatalf("created = %+v", saved)
	}
	alice.ok("model_guides", `{"action":"upsert","id":"flash-1017","changeSummary":"sess_1 stopped early",
		"sections":{"pitfalls":"- Stops at the first red test."}}`, &saved)
	if saved.Guide.Revision != 2 || saved.Guide.Sections.Summary != "Fast and cheap." || saved.Guide.Sections.Pitfalls == "" {
		t.Fatalf("partial upsert = %+v", saved)
	}
	alice.ok("model_guides", `{"action":"add_alias","id":"flash-1017","model":"deepseek/flash"}`, &saved)
	if saved.Guide.Revision != 3 || len(saved.Guide.Aliases) != 2 {
		t.Fatalf("add_alias = %+v", saved)
	}
	alice.ok("model_guides", `{"action":"resolve","model":"DeepSeek/Flash","providerId":"anywhere"}`, &resolution)
	if resolution.Guide == nil || resolution.Guide.ID != "flash-1017" || resolution.Guide.AliasCount != 2 || !resolution.SuggestedIDTaken {
		t.Fatalf("resolve by alias = %+v", resolution)
	}
	var observation store.ModelObservation
	alice.ok("model_guides", `{"action":"observe","id":"flash-1017","body":"Skipped the rerun.","sessionIds":["sess_1","sess_2"]}`, &observation)
	if observation.AuthorSessionID == "" || len(observation.SessionIDs) != 2 {
		t.Fatalf("observation = %+v", observation)
	}
	alice.ok("model_guides", `{"action":"remove_alias","id":"flash-1017","model":"deepseek/flash"}`, &saved)
	if saved.Guide.Revision != 4 || len(saved.Guide.Aliases) != 1 {
		t.Fatalf("remove_alias = %+v", saved)
	}
	if text, failed, _ := alice.call("model_guides", `{"action":"upsert","id":"flash-1017","changeSummary":"x","sections":{"avoid":"- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7\n- 8\n- 9"}}`); !failed || !strings.Contains(text, "bullet points") {
		t.Fatalf("nine bullets = %q, failed %v", text, failed)
	}
	if text, failed, _ := alice.call("model_guides", `{"action":"upsert","id":"flash-1017","sections":{"avoid":"x"}}`); !failed || !strings.Contains(text, "changeSummary") {
		t.Fatalf("no changeSummary = %q, failed %v", text, failed)
	}

	var list store.ModelGuideList
	f.call(f.alice, http.MethodGet, "/api/model-guides", "", http.StatusOK, "list guides", &list)
	if len(list.Guides) != 1 || list.Guides[0].Revision != 4 || list.Guides[0].AliasCount != 1 || list.Guides[0].Summary != "Fast and cheap." {
		t.Fatalf("list = %+v", list)
	}
	var detail store.ModelGuideDetail
	f.call(f.alice, http.MethodGet, "/api/model-guides/flash-1017", "", http.StatusOK, "guide detail", &detail)
	if detail.Guide.ID != "flash-1017" || len(detail.Revisions) != 4 || detail.Revisions[0].Revision != 4 ||
		detail.Observations.Total != 1 || len(detail.Facts.Providers) != 1 {
		t.Fatalf("detail = %+v", detail)
	}
	facts := detail.Facts
	if p := facts.Providers[0]; p.ProviderLabel != "Hub" || p.ContextWindow != 256000 || p.TokensPerMinute != 1_000_000 || p.WorkerGroupLabel != "Hub flash" {
		t.Fatalf("provider facts = %+v", p)
	}
	if facts.Usage.WindowDays != 30 || facts.Usage.WorkerSessions != 1 || facts.Usage.Requests != 1 ||
		facts.Usage.AvgRequestMs != 3000 || facts.Usage.TokPerSec != 100 {
		t.Fatalf("usage facts = %+v", facts.Usage)
	}
	var revision store.ModelGuideRevision
	f.call(f.alice, http.MethodGet, "/api/model-guides/flash-1017/revisions/1", "", http.StatusOK, "revision", &revision)
	if revision.Snapshot.Revision != 1 || revision.ChangeSummary != "first guide" || revision.Snapshot.Sections.Pitfalls != "" {
		t.Fatalf("revision = %+v", revision)
	}
	var obsPage store.ModelObservationPage
	f.call(f.alice, http.MethodGet, "/api/model-guides/flash-1017/observations?offset=0&limit=5", "", http.StatusOK, "observation page", &obsPage)
	f.call(f.bob, http.MethodGet, "/api/model-guides/flash-1017/observations", "", http.StatusNotFound, "another person's observations", nil)
	f.call(f.alice, http.MethodGet, "/api/model-guides/flash-1017/revisions/9", "", http.StatusNotFound, "missing revision", nil)
	f.call(f.alice, http.MethodGet, "/api/model-guides/flash-1017/revisions/x", "", http.StatusBadRequest, "bad revision", nil)
	f.call(f.alice, http.MethodGet, "/api/model-guides/resolve?providerKind=api&providerId=provider_hub&runtime=codex&model=flash-1017", "",
		http.StatusOK, "resolve over HTTP", &resolution)
	if resolution.Guide == nil || resolution.MatchedAlias == nil || resolution.MatchedAlias.ProviderID != "provider_hub" {
		t.Fatalf("HTTP resolve = %+v", resolution)
	}
	var batch store.ModelGuideResolveBatchResult
	f.call(f.alice, http.MethodPost, "/api/model-guides/resolve",
		`{"targets":[{"providerKind":"api","providerId":"provider_hub","runtime":"codex","model":"flash-1017"},{"model":"unknown-model-7"}]}`,
		http.StatusOK, "batch resolve", &batch)
	if len(batch.Resolutions) != 2 || batch.Resolutions[0].Guide == nil || batch.Resolutions[1].Guide != nil ||
		batch.Resolutions[1].SuggestedID != "unknown-model-7" {
		t.Fatalf("batch resolve = %+v", batch)
	}
	f.call(f.alice, http.MethodPost, "/api/model-guides/resolve", `{"targets":[{"model":"x","runtime":"gemini"}]}`, http.StatusBadRequest, "batch with a bad runtime", nil)
	f.call(f.alice, http.MethodGet, "/api/model-guides/resolve?model=x&runtime=gemini", "", http.StatusBadRequest, "bad runtime", nil)
	f.call(f.bob, http.MethodGet, "/api/model-guides/flash-1017", "", http.StatusNotFound, "another person's guide", nil)
	f.call(f.alice, http.MethodPut, "/api/model-guides/flash-1017", `{}`, http.StatusMethodNotAllowed, "no editing over HTTP", nil)

	bob := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.bobID, AgentID: "agent_bob", WorkspaceID: "ws_bob"})
	if text, failed, _ := bob.call("model_guides", `{"action":"get","id":"flash-1017"}`); !failed || !strings.Contains(text, "model guide not found") {
		t.Fatalf("bob get = %q, failed %v", text, failed)
	}
}

func TestModelGuidesToolHiddenFromIssueSessionsAndOldNoteToolsGone(t *testing.T) {
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification} {
		if err := mcpToolAllowed(role, false, "model_guides"); err == nil {
			t.Fatalf("%s may use model_guides", role)
		}
	}
	if err := mcpToolAllowed("", true, "model_guides"); err == nil {
		t.Fatal("a verifier may use model_guides")
	}
	if err := mcpToolAllowed("", false, "model_guides"); err != nil {
		t.Fatalf("a chat cannot use model_guides: %v", err)
	}
	for _, name := range []string{"get_model_notes", "append_model_note"} {
		if _, ok := mcpToolHandlers[name]; ok {
			t.Fatalf("%s is still a tool", name)
		}
		if modelProviderMCPTools[name] {
			t.Fatalf("%s is still a provider tool", name)
		}
	}
	if _, ok := mcpToolHandlers["model_guides"]; !ok {
		t.Fatal("model_guides is not a tool")
	}
}
