package httpapi

import (
	"cmp"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func defaultsAccount(profile, runtime string, usable bool) workspaceAccount {
	account := workspaceAccount{ProfileID: profile, Name: profile, Runtime: runtime, Usable: usable, agent: store.AgentProjection{ID: "agent_" + profile, Status: "healthy"}}
	if !usable {
		account.Problem = accountNotSignedIn
	}
	return account
}

func level(source, profile, runtime, model, effort string) agentDefaultLevel {
	return agentDefaultLevel{source: source, value: store.AgentDefault{ProfileID: profile, Runtime: runtime, Model: model, Effort: effort}}
}

// Most specific first, each field on its own: a chat's override, the bot's
// default, the workspace's, then the person's own account. A model or
// effort chosen for an account a more specific level replaced is dropped,
// and one for another runtime never applies.
func TestResolveAgentLevels(t *testing.T) {
	accounts := []workspaceAccount{
		defaultsAccount("claude_local", "claude", true),
		defaultsAccount("codex_local", "codex", true),
		defaultsAccount("codex_gateway", "codex", false),
	}
	accounts[1].LastWorkedAt = "2026-10-27T10:00:00Z"
	workspace := level(agentFromWorkspace, "codex_local", "codex", "gpt-6", "high")
	for _, want := range []struct {
		name                           string
		levels                         []agentDefaultLevel
		runtime                        string
		profile, source, model, effort string
		modelSource, effortSource      string
		skipped                        int
	}{
		{name: "no defaults: the person's last used", profile: "codex_local", source: accountLastUsed},
		{name: "workspace", levels: []agentDefaultLevel{workspace}, profile: "codex_local", source: agentFromWorkspace,
			model: "gpt-6", effort: "high", modelSource: agentFromWorkspace, effortSource: agentFromWorkspace},
		{name: "bot sets only the effort", levels: []agentDefaultLevel{level(agentFromFeishuBot, "", "codex", "", "low"), workspace},
			profile: "codex_local", source: agentFromWorkspace, model: "gpt-6", effort: "low", modelSource: agentFromWorkspace, effortSource: agentFromFeishuBot},
		{name: "chat replaces the account: the workspace's model and effort were for another",
			levels:  []agentDefaultLevel{level(agentFromFeishuChat, "claude_local", "claude", "", ""), level(agentFromFeishuBot, "", "codex", "", "low"), workspace},
			profile: "claude_local", source: agentFromFeishuChat},
		{name: "chat model for the bot's account", levels: []agentDefaultLevel{level(agentFromFeishuChat, "", "claude", "opus-9", "max"), level(agentFromFeishuBot, "claude_local", "claude", "", ""), workspace},
			profile: "claude_local", source: agentFromFeishuBot, model: "opus-9", effort: "max", modelSource: agentFromFeishuChat, effortSource: agentFromFeishuChat},
		{name: "an unusable default falls through, with a note", levels: []agentDefaultLevel{level(agentFromWorkspace, "codex_gateway", "codex", "gpt-6", "high")},
			profile: "codex_local", source: accountLastUsed, skipped: 1},
		{name: "a missing default falls through", levels: []agentDefaultLevel{level(agentFromFeishuBot, "gone", "codex", "", ""), workspace},
			profile: "codex_local", source: agentFromWorkspace, model: "gpt-6", effort: "high", modelSource: agentFromWorkspace, effortSource: agentFromWorkspace, skipped: 1},
		{name: "another runtime asked for: passed over quietly", levels: []agentDefaultLevel{workspace}, runtime: "claude",
			profile: "claude_local", source: accountFirstUsable},
		{name: "a model without an account keeps to its runtime", levels: []agentDefaultLevel{level(agentFromWorkspace, "", "codex", "gpt-6", "xhigh")}, runtime: "claude",
			profile: "claude_local", source: accountFirstUsable},
		{name: "an effort another runtime lacks is dropped", levels: []agentDefaultLevel{level(agentFromWorkspace, "", "", "", "minimal")}, runtime: "claude",
			profile: "claude_local", source: accountFirstUsable},
	} {
		t.Run(want.name, func(t *testing.T) {
			choice, ok := resolveAgent(accounts, want.levels, want.runtime, "")
			if !ok {
				t.Fatal("no account")
			}
			if choice.ProfileID != want.profile || choice.AccountSource != want.source || choice.Model != want.model || choice.Effort != want.effort ||
				choice.ModelSource != want.modelSource || choice.EffortSource != want.effortSource || len(choice.Skipped) != want.skipped {
				t.Fatalf("choice = %+v", choice)
			}
			if (choice.note() != "") != (want.skipped > 0) {
				t.Fatalf("note = %q", choice.note())
			}
		})
	}
	if _, ok := resolveAgent(accounts[2:], []agentDefaultLevel{workspace}, "", ""); ok {
		t.Fatal("an account was chosen where none is usable")
	}
}

// The workspace's maintainers set its default agent and its Feishu bot's
// and chats'; anyone in it reads what each start runs as. Each level wins
// where it applies; one that cannot run falls through, says so in the
// transcript, and never stops the session.
func TestWorkspaceDefaultAgent(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	agent := func(profile, runtime, status string) store.AgentProjection {
		return store.AgentProjection{
			ID: "agent_" + profile, WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: runtime, ProfileID: profile, ProfileLabel: profile,
			ConnectionType: "local_login", Status: status, AuthMode: "local_config", SecretStored: "local", ConfigScope: "device", ConfigLabel: "local", LastSeenLabel: "online",
		}
	}
	register := func(codexStatus string) {
		t.Helper()
		if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "W", LocalPath: "/tmp/ws_alice"},
			Agents:    []store.AgentProjection{agent("claude_local", "claude", "healthy"), agent("codex_local", "codex", codexStatus)},
		}); err != nil {
			t.Fatal(err)
		}
	}
	register("healthy")
	const path = "/api/workspaces/ws_alice/agent-defaults"

	var answer workspaceAgentDefaults
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "read without defaults", &answer)
	if len(answer.Defaults) != 0 || answer.Effective == nil || answer.Effective.ProfileID != "claude_local" || answer.Effective.AccountSource != accountFirstUsable {
		t.Fatalf("without defaults: %+v", answer)
	}
	f.call(f.bob, http.MethodGet, path, "", http.StatusNotFound, "bob is not in the workspace", nil)
	if err := f.db.SetWorkspaceMember(ctx, "ws_alice", f.bobID, store.WorkspaceRoleMember, "test"); err != nil {
		t.Fatal(err)
	}
	f.call(f.bob, http.MethodGet, path, "", http.StatusOK, "a member reads", nil)
	f.call(f.bob, http.MethodPut, path, `{"scope":"workspace","profileId":"codex_local"}`, http.StatusForbidden, "a member sets", nil)
	f.call(f.alice, http.MethodPut, path, `{"scope":"workspace","profileId":"codex_local","effort":"max"}`, http.StatusBadRequest, "Claude's effort for Codex", nil)
	f.call(f.alice, http.MethodPut, path, `{"scope":"workspace","profileId":"someone_else"}`, http.StatusBadRequest, "an account not on the device", nil)
	f.call(f.alice, http.MethodPut, path, `{"scope":"feishu_chat","routeId":"nope","model":"x","runtime":"codex"}`, http.StatusNotFound, "an unknown chat", nil)
	f.call(f.alice, http.MethodPut, path, `{"scope":"workspace","profileId":"codex_local","model":"gpt-6","effort":"high"}`, http.StatusOK, "set the workspace default", &answer)
	if e := answer.Effective; e == nil || e.ProfileID != "codex_local" || e.AccountSource != agentFromWorkspace || e.Model != "gpt-6" || e.Effort != "high" {
		t.Fatalf("effective = %+v", answer.Effective)
	}

	start := func(input store.CreateAgentSessionInput) store.CreateAgentSessionInput {
		t.Helper()
		input.WorkspaceID, input.CreatedByUserID, input.Prompt = "ws_alice", f.bobID, "go"
		input.Source = cmp.Or(input.Source, "chat")
		if err := f.server.chooseSessionAccount(ctx, &input); err != nil {
			t.Fatal(err)
		}
		return input
	}
	if input := start(store.CreateAgentSessionInput{}); input.ProfileID != "codex_local" || input.Provider != "codex" || input.Model != "gpt-6" || input.CodexReasoningEffort != "high" || input.ProfileTransitionNote != "" {
		t.Fatalf("a start naming nothing: %+v", input)
	}
	if input := start(store.CreateAgentSessionInput{Model: "gpt-6-mini"}); input.ProfileID != "codex_local" || input.Model != "gpt-6-mini" || input.CodexReasoningEffort != "high" {
		t.Fatalf("a start naming its model: %+v", input)
	}
	if input := start(store.CreateAgentSessionInput{ProfileID: "claude_local", Provider: "claude"}); input.Model != "" || input.ClaudeEffort != "" {
		t.Fatalf("an explicit account took defaults: %+v", input)
	}

	// A Feishu bot with one chat: the bot sets an effort, the chat another account.
	app := f.createApp(f.alice, "")
	if err := f.db.SetWorkspaceFeishuBotApp(ctx, "ws_alice", app.ID); err != nil {
		t.Fatal(err)
	}
	pairing, err := f.db.SetFeishuPairingCode(ctx, "ws_alice", "hash", f.aliceID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	chat, err := f.db.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_team", BoundUserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	f.call(f.alice, http.MethodPut, path, `{"scope":"feishu_bot","runtime":"codex","effort":"low"}`, http.StatusOK, "set the bot's effort", &answer)
	if b := answer.FeishuBot; b == nil || b.ProfileID != "codex_local" || b.Model != "gpt-6" || b.Effort != "low" || b.EffortSource != agentFromFeishuBot {
		t.Fatalf("the bot's = %+v", answer.FeishuBot)
	}
	if input := start(store.CreateAgentSessionInput{FeishuRouteID: chat.ID}); input.ProfileID != "codex_local" || input.CodexReasoningEffort != "low" {
		t.Fatalf("a topic without a chat override: %+v", input)
	}
	f.call(f.alice, http.MethodPut, path, `{"scope":"feishu_chat","routeId":"`+chat.ID+`","profileId":"claude_local"}`, http.StatusOK, "set the chat's account", &answer)
	if c, ok := answer.FeishuChats[chat.ID]; !ok || c.ProfileID != "claude_local" || c.AccountSource != agentFromFeishuChat || c.Model != "" || c.Effort != "" {
		t.Fatalf("the chat's = %+v", answer.FeishuChats)
	}
	if input := start(store.CreateAgentSessionInput{FeishuRouteID: chat.ID}); input.ProfileID != "claude_local" || input.Model != "" || input.ClaudeEffort != "" {
		t.Fatalf("a topic in the chat: %+v", input)
	}
	if input := start(store.CreateAgentSessionInput{}); input.ProfileID != "codex_local" || input.CodexReasoningEffort != "high" {
		t.Fatalf("a Web chat took the channel's default: %+v", input)
	}

	// Codex signs out: the workspace default is passed over, visibly.
	register("missing_auth")
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "read with an unusable default", &answer)
	var shown agentDefaultView
	for _, value := range answer.Defaults {
		if value.Scope == store.AgentDefaultWorkspace {
			shown = value
		}
	}
	if shown.Problem != accountNotSignedIn || answer.Effective == nil || answer.Effective.ProfileID != "claude_local" || len(answer.Effective.Skipped) != 1 {
		t.Fatalf("with codex signed out: %+v / %+v", shown, answer.Effective)
	}
	input := start(store.CreateAgentSessionInput{})
	if input.ProfileID != "claude_local" || input.Model != "" || input.ClaudeEffort != "" ||
		!strings.Contains(input.ProfileTransitionNote, `the workspace default account "codex_local" (it is not signed in)`) {
		t.Fatalf("a start past an unusable default: %+v", input)
	}
	if input := start(store.CreateAgentSessionInput{Source: "naming"}); input.ProfileTransitionNote != "" {
		t.Fatalf("a naming job took the defaults: %+v", input)
	}

	// Clearing every field inherits again.
	f.call(f.alice, http.MethodPut, path, `{"scope":"workspace"}`, http.StatusOK, "clear the workspace default", &answer)
	f.call(f.alice, http.MethodPut, path, `{"scope":"feishu_bot"}`, http.StatusOK, "clear the bot's", &answer)
	if len(answer.Defaults) != 1 || answer.Effective == nil || len(answer.Effective.Skipped) != 0 {
		t.Fatalf("after clearing: %+v", answer)
	}
}
