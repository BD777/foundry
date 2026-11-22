package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workspaceFolders are the folders of a fake device's workspaces, by id.
type workspaceFolders struct {
	mu      sync.Mutex
	folders map[string]map[string]string
}

func (w *workspaceFolders) get(workspaceID, path string) (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	content, ok := w.folders[workspaceID][path]
	return content, ok
}

func (w *workspaceFolders) set(workspaceID, path string, content *string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.folders[workspaceID] == nil {
		w.folders[workspaceID] = map[string]string{}
	}
	if content == nil {
		delete(w.folders[workspaceID], path)
		return
	}
	w.folders[workspaceID][path] = *content
}

func (w *workspaceFolders) answers() map[string]fakeAnswer {
	return map[string]fakeAnswer{
		wsWriteFileType: func(raw json.RawMessage) (string, any) {
			var request wsWriteFilePayload
			_ = json.Unmarshal(raw, &request)
			w.set(request.WorkspaceID, request.Path, &request.Content)
			return wsFileWrittenType, wsFileWrittenPayload{WorkspaceID: request.WorkspaceID, Path: request.Path, Sha256: contentSha256(request.Content), Bytes: len(request.Content)}
		},
		wsListWorkspaceTreeType: func(raw json.RawMessage) (string, any) {
			var request wsListWorkspaceTreePayload
			_ = json.Unmarshal(raw, &request)
			w.mu.Lock()
			defer w.mu.Unlock()
			prefix := strings.Trim(request.Path, "/") + "/"
			entries := []map[string]any{}
			for path := range w.folders[request.WorkspaceID] {
				if rest, ok := strings.CutPrefix(path, prefix); ok && !strings.Contains(rest, "/") {
					entries = append(entries, map[string]any{"name": rest, "path": path, "isDirectory": false})
				}
			}
			return wsWorkspaceTreeListedType, map[string]any{"workspaceId": request.WorkspaceID, "path": request.Path, "entries": entries}
		},
		wsManageFileType: func(raw json.RawMessage) (string, any) {
			var request wsManageFilePayload
			_ = json.Unmarshal(raw, &request)
			w.set(request.WorkspaceID, request.Path, nil)
			return wsFileManagedType, wsFileManagedPayload{WorkspaceID: request.WorkspaceID, Op: request.Op, Path: request.Path}
		},
	}
}

// An item of the device's owner is written into its home's
// .foundry/items/<id>.md when it changes; another person's item homed there
// is not;
// a new home gets the file and the old one loses it; a finished item keeps
// its file until it is archived. A device that connects again gets what
// changed and loses files of items no longer at home there.
// The assistant lives in its own workspace: an item homed there is its inbox,
// which has no file.
func TestItemFilesFollowTheirHome(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	registerDeviceForTest(t, f.server, registrationBody("dev_alice", "ws_alice2"))
	if _, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, HomeDeviceID: "dev_alice", WorkspaceID: "ws_alice_assistant", Settings: personalagent.DefaultSettings(),
	}); err != nil {
		t.Fatal(err)
	}
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	live := httptest.NewServer(f.handler)
	t.Cleanup(live.Close)
	folders := &workspaceFolders{folders: map[string]map[string]string{}}
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": allFileCapabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w"},
	}, folders.answers())

	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		UserID: f.aliceID, AssistantID: agent.ID, Text: "Ship the ledger", Quote: "ship the ledger", HomeWorkspaceID: "ws_alice",
		Plan: &store.PersonalAgentItemPlan{Mode: "execute", Progress: "started"}})
	if err != nil {
		t.Fatal(err)
	}
	path := assistant.ItemFilesDir + "/" + item.ID + ".md"
	waitFor(t, "the item file in its home", func() bool {
		content, ok := folders.get("ws_alice", path)
		return ok && strings.Contains(content, assistant.ItemFileNotice) && strings.Contains(content, "home: \"ws_alice\"") && strings.Contains(content, "进展：started")
	})

	item.HomeWorkspaceID = "ws_alice2"
	if item, err = f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the file moved to the new home", func() bool {
		_, old := folders.get("ws_alice", path)
		content, moved := folders.get("ws_alice2", path)
		return !old && moved && strings.Contains(content, "home: \"ws_alice2\"") && strings.Contains(content, "rehomed：ws_alice → ws_alice2")
	})

	item.Status = store.PersonalAgentItemDone
	if item, err = f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, item); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a finished item keeps its file", func() bool {
		content, ok := folders.get("ws_alice2", path)
		return ok && strings.Contains(content, "status: \"done\"")
	})
	if _, err := f.server.store.SetPersonalAgentItemArchived(ctx, store.PersonalAgentActorPerson, agent.ID, item.ID, true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "an archived item's file is removed", func() bool {
		_, ok := folders.get("ws_alice2", path)
		return !ok
	})

	other, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		UserID: f.aliceID, AssistantID: agent.ID, Text: "Write the docs", Quote: "write the docs", HomeWorkspaceID: "ws_alice"})
	if err != nil {
		t.Fatal(err)
	}
	otherPath := assistant.ItemFilesDir + "/" + other.ID + ".md"
	waitFor(t, "the second item's file", func() bool {
		_, ok := folders.get("ws_alice", otherPath)
		return ok
	})
	stale := "left over"

	// Another person's item homed in the same workspace gets no file, and
	// one written before is removed; the owner's item keeps its own.
	bobs, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		UserID: f.bobID, AssistantID: "asst_bob", Text: "Bob's private plan", Quote: "bob's private plan", HomeWorkspaceID: "ws_alice"})
	if err != nil {
		t.Fatal(err)
	}
	bobsPath := assistant.ItemFilesDir + "/" + bobs.ID + ".md"
	folders.set("ws_alice", bobsPath, &stale)
	waitFor(t, "another person's item file is removed", func() bool {
		_, ok := folders.get("ws_alice", bobsPath)
		return !ok
	})
	bobs.Plan = &store.PersonalAgentItemPlan{Mode: "execute", Progress: "secret progress"}
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorAssistant, bobs); err != nil {
		t.Fatal(err)
	}
	f.server.assistant.ProjectDeviceItemFiles(ctx, "dev_alice")
	if _, ok := folders.get("ws_alice", bobsPath); ok {
		t.Fatal("another person's item got a file in the owner's workspace")
	}
	if content, ok := folders.get("ws_alice", otherPath); !ok || !strings.Contains(content, "Write the docs") {
		t.Fatalf("the owner's item beside it: %q %v", content, ok)
	}
	folders.mu.Lock()
	for path, content := range folders.folders["ws_alice"] {
		if strings.Contains(content, "Bob's private plan") || strings.Contains(content, "secret progress") {
			t.Errorf("another person's item leaked into %s", path)
		}
	}
	folders.mu.Unlock()

	folders.set("ws_alice", otherPath, nil)
	folders.set("ws_alice", assistant.ItemFilesDir+"/pai_gone.md", &stale)
	f.server.assistant.ProjectDeviceItemFiles(ctx, "dev_alice")
	if _, ok := folders.get("ws_alice", otherPath); !ok {
		t.Fatal("a reconnect did not write the missing item file")
	}
	if _, ok := folders.get("ws_alice", assistant.ItemFilesDir+"/pai_gone.md"); ok {
		t.Fatal("a reconnect kept the file of an item no longer at home")
	}
	if _, ok := folders.get("ws_alice2", path); ok {
		t.Fatal("a reconnect brought back an archived item's file")
	}
}

// A device that connects is asked about the item files only of workspaces an
// item has or had as its home: one no item ever lived in is not listed, while
// one an item left still loses its stale files.
func TestItemFilesAskOnlyWorkspacesItemsLivedIn(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	registerDeviceForTest(t, f.server, registrationBody("dev_alice", "ws_alice2"))
	agent, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, HomeDeviceID: "dev_alice", WorkspaceID: "ws_alice", Settings: personalagent.DefaultSettings(),
	})
	if err != nil {
		t.Fatal(err)
	}
	live := httptest.NewServer(f.handler)
	t.Cleanup(live.Close)
	folders := &workspaceFolders{folders: map[string]map[string]string{}}
	answers := folders.answers()
	var mu sync.Mutex
	listed := map[string]int{}
	list := answers[wsListWorkspaceTreeType]
	answers[wsListWorkspaceTreeType] = func(raw json.RawMessage) (string, any) {
		var request wsListWorkspaceTreePayload
		_ = json.Unmarshal(raw, &request)
		if strings.Trim(request.Path, "/") == assistant.ItemFilesDir {
			mu.Lock()
			listed[request.WorkspaceID]++
			mu.Unlock()
		}
		return list(raw)
	}
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": allFileCapabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w"},
	}, answers)

	item, err := f.server.store.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{
		UserID: f.aliceID, AssistantID: agent.ID, Text: "Ship the ledger", Quote: "ship the ledger", HomeWorkspaceID: "ws_alice2"})
	if err != nil {
		t.Fatal(err)
	}
	path := assistant.ItemFilesDir + "/" + item.ID + ".md"
	waitFor(t, "the item file in its home", func() bool { _, ok := folders.get("ws_alice2", path); return ok })
	item.HomeWorkspaceID, item.Revision = "", 0
	if _, err := f.server.store.SavePersonalAgentItem(ctx, store.PersonalAgentActorPerson, item); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the file leaves with the item", func() bool { _, ok := folders.get("ws_alice2", path); return !ok })

	stale := "stale"
	folders.set("ws_alice2", path, &stale)
	f.server.assistant.ProjectDeviceItemFiles(ctx, "dev_alice")
	if _, ok := folders.get("ws_alice2", path); ok {
		t.Fatal("a reconnect kept the file of an item that left the workspace")
	}
	mu.Lock()
	defer mu.Unlock()
	if listed["ws_alice"] != 0 || listed["ws_alice2"] == 0 {
		t.Fatalf("item file listings by workspace = %v, want none of ws_alice, where no item lived", listed)
	}
}
