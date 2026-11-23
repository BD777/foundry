package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// find_in_projects looks a name up in what the person's readable projects
// mention: their chats (what the person and the agent wrote, not tool
// output), sessions and the skills on their computers; a project the
// person cannot read is never searched. The project files name each
// project's distinctive names.
func TestFindInProjectsLooksNamesUpInReadableProjects(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	chats := f.server.store.(store.DaemonChangeStore)
	sync := func(workspaceID, chatID, title string, messages ...store.TranscriptMessage) {
		t.Helper()
		if _, err := chats.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: workspaceID, Chats: []store.ChatThread{{
			ID: chatID, WorkspaceID: workspaceID, Provider: "claude", NativeSessionID: chatID, Title: title,
			Status: "completed", UpdatedAt: "2026-11-20T10:00:00Z", Transcript: messages,
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	sync("ws_alice", "native_claude_tokyo", "Check the Tokyo box",
		store.TranscriptMessage{ID: "u1", Kind: "user", Text: "ssh sats-tokyo-7 and look at the hyperliquid maker"},
		store.TranscriptMessage{ID: "t1", Kind: "tool", Text: "cliproxyapi cliproxyapi cliproxyapi"},
		store.TranscriptMessage{ID: "a1", Kind: "assistant", Text: "sats-tokyo-7 is healthy; tokyo9 too."})
	sync("ws_bob", "native_claude_proxy", "Proxy restart",
		store.TranscriptMessage{ID: "u1", Kind: "user", Text: "restart cliproxyapi on the aws box"})
	f.startSession(t, "ws_bob", "", "check the aws bill")
	if err := f.server.store.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_bob", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_carol", Name: "ws_carol", LocalPath: "/tmp/ws_carol"},
	}); err != nil {
		t.Fatal(err)
	}
	sync("ws_carol", "native_claude_carol", "Not alice's", store.TranscriptMessage{ID: "u1", Kind: "user", Text: "sats-tokyo-7 sats-tokyo-7 aws"})
	if _, err := f.server.store.ReplaceDeviceSkills(ctx, store.ReplaceDeviceSkillsInput{DeviceID: "dev_alice", Skills: []store.DeviceSkill{
		{DeviceID: "dev_alice", Root: "~/.claude/skills", DirName: "ecm-migration", Name: "ecm-migration"},
		{DeviceID: "dev_alice", Root: "/tmp/ws_alice/.agents/skills", DirName: "tce-startup", Name: "tce-startup"},
	}}); err != nil {
		t.Fatal(err)
	}

	find := func(arguments map[string]any) workspacedigest.FindResult {
		t.Helper()
		text, failed := f.tool(t, f.token, "find_in_projects", arguments)
		if failed {
			t.Fatalf("find_in_projects %v: %s", arguments, text)
		}
		var result workspacedigest.FindResult
		if err := json.Unmarshal([]byte(text), &result); err != nil {
			t.Fatalf("%v: %s", err, text)
		}
		return result
	}
	// Two refreshes count every source (each counts the newest first).
	find(map[string]any{"query": "warm"})

	tokyo := find(map[string]any{"query": "sats-tokyo"})
	if tokyo.Total != 1 || len(tokyo.Projects) != 1 {
		t.Fatalf("sats-tokyo: %+v", tokyo)
	}
	hit := tokyo.Projects[0]
	if hit.WorkspaceID != "ws_alice" || hit.Mentions != 2 || hit.Sources != 1 || len(hit.Matched) != 1 || hit.Matched[0] != "sats-tokyo-7" ||
		len(hit.Examples) != 1 || hit.Examples[0].ID != "native_claude_tokyo" || hit.Examples[0].Kind != store.WorkspaceTermChat || hit.Examples[0].Title != "Check the Tokyo box" {
		t.Fatalf("sats-tokyo hit: %+v", hit)
	}

	proxy := find(map[string]any{"query": "cliproxyapi"})
	if proxy.Total != 1 || proxy.Projects[0].WorkspaceID != "ws_bob" {
		t.Fatalf("cliproxyapi counted tool output or missed the chat: %+v", proxy)
	}
	aws := find(map[string]any{"query": "aws"})
	if aws.Total != 1 || aws.Projects[0].WorkspaceID != "ws_bob" || aws.Projects[0].Sources != 2 {
		t.Fatalf("aws: %+v", aws)
	}
	both := find(map[string]any{"query": "hyperliquid maker"})
	if both.Total != 1 || both.Projects[0].WorkspaceID != "ws_alice" {
		t.Fatalf("hyperliquid maker: %+v", both)
	}
	if none := find(map[string]any{"query": "hyperliquid aws"}); none.Total != 0 {
		t.Fatalf("terms of different projects matched together: %+v", none)
	}
	if chinese := find(map[string]any{"query": "东京那台"}); len(chinese.Terms) != 0 || chinese.Note == "" {
		t.Fatalf("a query without names: %+v", chinese)
	}

	skills := find(map[string]any{"query": "ecm-migration"})
	if len(skills.Skills) != 1 || skills.Skills[0].Scope != workspacedigest.SkillScopeComputer || skills.Skills[0].DeviceID != "dev_alice" {
		t.Fatalf("a computer's skill: %+v", skills.Skills)
	}
	local := find(map[string]any{"query": "tce-startup"})
	if len(local.Skills) != 1 || local.Skills[0].Scope != workspacedigest.SkillScopeProjects || len(local.Skills[0].Projects) != 1 || local.Skills[0].Projects[0].WorkspaceID != "ws_alice" {
		t.Fatalf("a project's skill: %+v", local.Skills)
	}

	if text, failed := f.tool(t, f.token, "find_in_projects", map[string]any{"query": " "}); !failed || !strings.Contains(text, "query is required") {
		t.Fatalf("an empty query: %s", text)
	}

	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	files, err := f.server.assistant.ProjectFiles(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file.Path, "/ws-alice.md") {
			if !strings.Contains(file.Content, "## Names talked about here") || !strings.Contains(file.Content, "sats-tokyo-7 (2)") {
				t.Fatalf("ws_alice's project file:\n%s", file.Content)
			}
			return
		}
	}
	t.Fatalf("no project file for ws_alice: %+v", files)
}
