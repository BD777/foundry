package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeFolder is a workspace folder on a fake device: read_file, write_file
// (with its sha256 check) and manage_file over a map.
type fakeFolder struct {
	mu    sync.Mutex
	files map[string]string
	// realPaths: a path reached through a link inside the workspace, and
	// where it leads; foundrySkills: files of skills Foundry linked in.
	realPaths     map[string]string
	foundrySkills map[string]bool
}

func (folder *fakeFolder) get(path string) (string, bool) {
	folder.mu.Lock()
	defer folder.mu.Unlock()
	content, ok := folder.files[path]
	return content, ok
}

func (folder *fakeFolder) answers() map[string]fakeAnswer {
	return map[string]fakeAnswer{
		wsReadFileType: func(raw json.RawMessage) (string, any) {
			var request wsReadFilePayloadForTest
			_ = json.Unmarshal(raw, &request)
			content, ok := folder.get(request.Path)
			if !ok {
				return wsFileReadType, map[string]any{"workspaceId": request.WorkspaceID, "path": request.Path, "error": "ENOENT: no such file or directory"}
			}
			answer := map[string]any{"workspaceId": request.WorkspaceID, "path": request.Path, "content": content}
			if real := folder.realPaths[request.Path]; real != "" {
				answer["realPath"] = real
			}
			if folder.foundrySkills[request.Path] {
				answer["readOnly"] = true
			}
			return wsFileReadType, answer
		},
		wsWriteFileType: func(raw json.RawMessage) (string, any) {
			var request wsWriteFilePayload
			_ = json.Unmarshal(raw, &request)
			folder.mu.Lock()
			defer folder.mu.Unlock()
			current, ok := folder.files[request.Path]
			sha := ""
			if ok {
				sha = contentSha256(current)
			}
			if request.ExpectedSha256 != nil && *request.ExpectedSha256 != sha {
				return wsFileWrittenType, wsFileWrittenPayload{WorkspaceID: request.WorkspaceID, Path: request.Path, Error: "the file changed since it was read", Code: "conflict"}
			}
			folder.files[request.Path] = request.Content
			return wsFileWrittenType, wsFileWrittenPayload{WorkspaceID: request.WorkspaceID, Path: request.Path, Sha256: contentSha256(request.Content), Bytes: len(request.Content)}
		},
		wsManageFileType: func(raw json.RawMessage) (string, any) {
			var request wsManageFilePayload
			_ = json.Unmarshal(raw, &request)
			folder.mu.Lock()
			defer folder.mu.Unlock()
			current := folder.files[request.Path]
			if request.ExpectedSha256 != nil && *request.ExpectedSha256 != contentSha256(current) {
				return wsFileManagedType, wsFileManagedPayload{Op: request.Op, Path: request.Path, Error: "changed", Code: "conflict"}
			}
			delete(folder.files, request.Path)
			if request.Op == "rename" {
				folder.files[request.ToPath] = current
			}
			return wsFileManagedType, wsFileManagedPayload{WorkspaceID: request.WorkspaceID, Op: request.Op, Path: request.Path, ToPath: request.ToPath}
		},
	}
}

type wsReadFilePayloadForTest struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

func assistantFilesFixture(t *testing.T, capabilities []string, files map[string]string) (isolationFixture, *fakeFolder) {
	t.Helper()
	f := newIsolationFixture(t)
	if _, err := f.server.store.CreatePersonalAgent(context.Background(), store.PersonalAgent{
		UserID: f.aliceID, HomeDeviceID: "dev_alice", WorkspaceID: "ws_alice", Settings: personalagent.DefaultSettings(),
	}); err != nil {
		t.Fatal(err)
	}
	live := httptest.NewServer(f.handler)
	t.Cleanup(live.Close)
	folder := &fakeFolder{files: files}
	connectFakeDevice(t, live, f.aliceDevice, map[string]any{
		"capabilities": capabilities,
		"device":       map[string]any{"id": "dev_alice", "label": "Alice's laptop", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_alice", "name": "W", "localPath": "/tmp/w"},
	}, folder.answers())
	return f, folder
}

func readAssistantFile(t *testing.T, f isolationFixture, path string) store.AssistantFile {
	t.Helper()
	response := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/files?workspaceId=ws_alice&path="+url.QueryEscape(path), ""))
	expectStatus(t, response, http.StatusOK, "read "+path)
	var file store.AssistantFile
	if err := json.Unmarshal(response.Body.Bytes(), &file); err != nil {
		t.Fatal(err)
	}
	return file
}

func fileCall(t *testing.T, f isolationFixture, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	return doAuthCall(t, f.handler, f.as(f.alice, method, path, string(raw)))
}

var allFileCapabilities = []string{store.DaemonCapabilityWorkspaceFileWrite, store.DaemonCapabilityWorkspaceFileManage, store.DaemonCapabilityAssistantInstructionsBlock}

// The home AGENTS.md opens as the person's instructions with Foundry's
// block beside it; a save over a stale version is refused, a save over the
// one seen keeps the block on top and both versions in the history.
func TestAssistantInstructionsAreThePersonsBelowTheManagedBlock(t *testing.T) {
	old := prompt.ManagedBlockStart + "\nYou are A.\n" + prompt.ManagedBlockEnd
	f, folder := assistantFilesFixture(t, allFileCapabilities, map[string]string{"AGENTS.md": old + "\n\nMine.\n"})

	list := fileCall(t, f, http.MethodGet, "/api/personal-agent/files/workspaces", nil)
	expectStatus(t, list, http.StatusOK, "list")
	var workspaces store.AssistantWorkspaceList
	_ = json.Unmarshal(list.Body.Bytes(), &workspaces)
	if len(workspaces.Workspaces) != 1 || workspaces.Workspaces[0].Kind != store.AssistantWorkspaceKindHome || !workspaces.Workspaces[0].CanManage {
		t.Fatalf("workspaces: %+v", workspaces.Workspaces)
	}

	file := readAssistantFile(t, f, "AGENTS.md")
	if file.Content != "Mine.\n" || file.ReadOnly != "" || file.Instructions == nil || !file.Instructions.ManagedPresent ||
		!strings.HasPrefix(file.Instructions.ManagedBlock, prompt.ManagedBlockStart) || file.Instructions.NewDefault {
		t.Fatalf("instructions: %+v %+v", file, file.Instructions)
	}
	stale := fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: "AGENTS.md", Content: "x", BaseSha256: contentSha256("other")})
	expectStatus(t, stale, http.StatusConflict, "stale save")

	saved := fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: "AGENTS.md", Content: "Mine, edited.\n", BaseSha256: file.Sha256})
	expectStatus(t, saved, http.StatusOK, "save")
	written, _ := folder.get("AGENTS.md")
	block, rest := prompt.SplitAgentsFile(written)
	if !strings.HasPrefix(written, prompt.ManagedBlockStart) || !strings.Contains(block, "You are Assistant") || rest != "Mine, edited.\n" {
		t.Fatalf("AGENTS.md on the device: %q", written)
	}
	var after store.AssistantFile
	_ = json.Unmarshal(saved.Body.Bytes(), &after)
	if len(after.Revisions) != 2 || after.Revisions[0].Source != "web" || !after.Revisions[0].Current || after.Revisions[1].Source != "seed" {
		t.Fatalf("revisions: %+v", after.Revisions)
	}
	reverted := fileCall(t, f, http.MethodPost, "/api/personal-agent/files/revert", store.AssistantFileRevert{WorkspaceID: "ws_alice", Path: "AGENTS.md", RevisionID: after.Revisions[1].ID, BaseSha256: after.Sha256})
	expectStatus(t, reverted, http.StatusOK, "revert")
	if reverted, _ := folder.get("AGENTS.md"); !strings.HasSuffix(reverted, "\n\nMine.\n") {
		t.Fatalf("reverted AGENTS.md: %q", reverted)
	}

	current, _ := folder.get("AGENTS.md")
	big := fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: "AGENTS.md", Content: strings.Repeat("x", prompt.AgentsFileMaxBytes), BaseSha256: contentSha256(current)})
	expectStatus(t, big, http.StatusBadRequest, "over the AGENTS.md budget")
	removal := fileCall(t, f, http.MethodPost, "/api/personal-agent/files/move", store.AssistantFileMove{WorkspaceID: "ws_alice", Path: "AGENTS.md", BaseSha256: ""})
	expectStatus(t, removal, http.StatusForbidden, "AGENTS.md is not deleted")
}

// Foundry's generated files are read-only; ordinary files are created,
// renamed and deleted, a deleted file's content staying among its versions.
func TestAssistantWorkspaceFilesCreateRenameDelete(t *testing.T) {
	f, folder := assistantFilesFixture(t, allFileCapabilities, map[string]string{
		"AGENTS.md": prompt.InitialAgentsFile(), ".foundry/project-index.md": "# Projects\n",
	})
	generated := readAssistantFile(t, f, ".foundry/project-index.md")
	if generated.ReadOnly != store.AssistantFileReadOnlyGenerated {
		t.Fatalf("generated file: %+v", generated)
	}
	expectStatus(t, fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: ".foundry/project-index.md", Content: "x", BaseSha256: generated.Sha256}), http.StatusForbidden, "generated file")
	expectStatus(t, fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: ".claude/skills/assistant-handoff/SKILL.md", Content: "x", BaseSha256: ""}), http.StatusForbidden, "generated skill link")

	expectStatus(t, fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: "notes/a.md", Content: "hello\n", BaseSha256: ""}), http.StatusOK, "create")
	expectStatus(t, fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: "notes/a.md", Content: "again\n", BaseSha256: ""}), http.StatusConflict, "create over an existing file")
	sha := contentSha256("hello\n")
	expectStatus(t, fileCall(t, f, http.MethodPost, "/api/personal-agent/files/move", store.AssistantFileMove{WorkspaceID: "ws_alice", Path: "notes/a.md", ToPath: "notes/b.md", BaseSha256: sha}), http.StatusOK, "rename")
	if _, ok := folder.get("notes/b.md"); !ok {
		t.Fatal("not renamed")
	}
	if renamed := readAssistantFile(t, f, "notes/b.md"); len(renamed.Revisions) != 1 || !renamed.Revisions[0].Current {
		t.Fatalf("the renamed file's versions: %+v", renamed.Revisions)
	}
	expectStatus(t, fileCall(t, f, http.MethodPost, "/api/personal-agent/files/move", store.AssistantFileMove{WorkspaceID: "ws_alice", Path: "notes/b.md", BaseSha256: sha}), http.StatusOK, "delete")
	if _, ok := folder.get("notes/b.md"); ok {
		t.Fatal("not deleted")
	}
	gone := readAssistantFile(t, f, "notes/b.md")
	if !gone.Missing || len(gone.Revisions) != 2 || gone.Revisions[0].Source != "deleted" {
		t.Fatalf("the deleted file: %+v", gone)
	}
	// A workspace that is not the assistant's is not reached here.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/files?workspaceId=ws_bob&path=a.md", "")), http.StatusNotFound, "another workspace")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/personal-agent/files?workspaceId=ws_alice&path=AGENTS.md", "")), http.StatusNotFound, "someone else")
}

// A Worker that writes AGENTS.md whole keeps the instructions read-only;
// a newer default is offered and taken only when the person says so.
func TestAssistantInstructionsOnAnOlderWorkerAndNewerDefaults(t *testing.T) {
	f, folder := assistantFilesFixture(t, []string{store.DaemonCapabilityWorkspaceFileWrite}, map[string]string{"AGENTS.md": prompt.InitialAgentsFile()})
	if file := readAssistantFile(t, f, "AGENTS.md"); file.ReadOnly != store.AssistantFileReadOnlyWholeFile {
		t.Fatalf("on an older Worker: %+v", file)
	}
	f, folder = assistantFilesFixture(t, allFileCapabilities, map[string]string{"AGENTS.md": prompt.JoinAgentsFile(prompt.ManagedBlockStart+"\n"+prompt.ManagedBlockEnd, "My own.\n")})
	agent, _ := f.server.store.GetPersonalAgent(context.Background(), f.aliceID)
	st, _ := f.server.workspaceFileStore()
	if err := st.SetAssistantInstructionsDefault(context.Background(), agent.ID, "an-older-default"); err != nil {
		t.Fatal(err)
	}
	file := readAssistantFile(t, f, "AGENTS.md")
	if file.Instructions == nil || !file.Instructions.NewDefault || file.Instructions.DefaultContent != prompt.DefaultInstructions() {
		t.Fatalf("newer default: %+v", file.Instructions)
	}
	adopted := fileCall(t, f, http.MethodPost, "/api/personal-agent/files/instructions-default", store.AssistantInstructionsDefault{Adopt: true, BaseSha256: file.Sha256})
	expectStatus(t, adopted, http.StatusOK, "adopt")
	if written, _ := folder.get("AGENTS.md"); !strings.HasSuffix(written, prompt.DefaultInstructions()) {
		t.Fatalf("adopted AGENTS.md: %q", written)
	}
	if file := readAssistantFile(t, f, "AGENTS.md"); file.Instructions.NewDefault || file.Revisions[0].Source != "default" {
		t.Fatalf("after adopting: %+v %+v", file.Instructions, file.Revisions)
	}
}

// A file opened through a link keeps the rules of where it leads: one in
// Foundry's .foundry folder is generated, a skill Foundry linked in from its
// snapshots is read-only; neither is saved, renamed or deleted (DEV-231).
func TestAssistantFilesThroughLinksKeepTheirTargetsRules(t *testing.T) {
	leftover := ".agents/skills/channel-old/SKILL.md"
	skill := ".agents/skills/review/SKILL.md"
	f, folder := assistantFilesFixture(t, allFileCapabilities, map[string]string{leftover: "# old", skill: "# review"})
	folder.realPaths = map[string]string{leftover: ".foundry/assistant-skills/channel-old/SKILL.md"}
	folder.foundrySkills = map[string]bool{skill: true}

	for path, want := range map[string]store.AssistantFileReadOnly{
		leftover: store.AssistantFileReadOnlyGenerated,
		skill:    store.AssistantFileReadOnlyFoundrySkill,
	} {
		file := readAssistantFile(t, f, path)
		if file.ReadOnly != want || file.Content == "" {
			t.Fatalf("%s: readOnly %q, content %q", path, file.ReadOnly, file.Content)
		}
		save := fileCall(t, f, http.MethodPut, "/api/personal-agent/files", store.AssistantFileWrite{WorkspaceID: "ws_alice", Path: path, Content: "changed", BaseSha256: file.Sha256})
		expectStatus(t, save, http.StatusForbidden, "save "+path)
		remove := fileCall(t, f, http.MethodPost, "/api/personal-agent/files/move", store.AssistantFileMove{WorkspaceID: "ws_alice", Path: path, BaseSha256: file.Sha256})
		expectStatus(t, remove, http.StatusForbidden, "delete "+path)
		if content, ok := folder.get(path); !ok || content == "changed" {
			t.Fatalf("%s changed on the device: %q %v", path, content, ok)
		}
	}
}
