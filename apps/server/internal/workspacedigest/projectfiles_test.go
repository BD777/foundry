package workspacedigest

import (
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestProjectFilesCoverTheProjectsAndNoOthers(t *testing.T) {
	now := time.Date(2026, 11, 16, 2, 0, 0, 0, time.UTC)
	digests := []store.WorkspaceDigest{
		{
			WorkspaceID: "ws_ccm_byte", Name: "ccm", DeviceLabel: "byte-dev", DeviceID: "dev_1", DeviceOnline: true,
			AccessRole: store.WorkspaceRoleOwner, Purpose: "The character model", Summary: "Works on the model.", L0: "ccm",
			RouteWhen: []string{"the character model"}, NotWhen: []string{"the website"},
			Skills: []string{"review"}, Connectors: []string{"feishu"},
			RecentSessions: []store.WorkspaceDigestSession{{Title: "Fix the walk cycle", Status: "completed", UpdatedAt: "2026-11-15T10:00:00Z"}},
			OpenIssues:     []store.WorkspaceDigestIssue{{Title: "Crash on load", Status: "open"}},
			GitBranch:      "main", LastActivityAt: "2026-11-15T10:00:00Z", CompiledAt: "2026-11-15T10:00:00Z", SummarizedAt: "2026-11-15T10:00:00Z",
		},
		{
			WorkspaceID: "ws_ccm_mac", Name: "ccm", DeviceLabel: "mac-mini", DeviceID: "dev_2", DeviceOnline: false,
			Purpose: "An older checkout", CompiledAt: "2026-11-01T10:00:00Z",
		},
		{WorkspaceID: "ws_old", Name: "Old", Archived: true},
		{WorkspaceID: "ws_pa", Name: "Assistant", Kind: store.WorkspaceKindPersonalAgent},
	}
	files := ProjectFiles(digests, map[string]bool{"ws_ccm_byte": true}, nil, now)
	if len(files) != 3 {
		t.Fatalf("project files = %d, want three (two copies and the manifest)", len(files))
	}
	paths := map[string]string{}
	for _, file := range files {
		paths[file.Path] = file.Content
	}
	if len(paths) != 3 {
		t.Fatalf("file paths = %+v", paths)
	}
	byteFile := paths[ProjectFilesDir+"/ccm-byte-dev.md"]
	macFile := paths[ProjectFilesDir+"/ccm-mac-mini.md"]
	if byteFile == "" || macFile == "" {
		t.Fatalf("duplicate names did not get distinct files: %+v", paths)
	}
	for _, want := range []string{"ws_ccm_byte", "byte-dev", "online", "The character model", "Works on the model.", "Route here when", "the character model", "Recent sessions", "Fix the walk cycle", "Open Issues", "Crash on load", "main", "cards/ws_ccm_byte.md"} {
		if !strings.Contains(byteFile, want) {
			t.Errorf("byte-dev summary lost %q:\n%s", want, byteFile)
		}
	}
	if strings.Contains(byteFile, "not summarized yet") {
		t.Errorf("a summarized project says it is not summarized:\n%s", byteFile)
	}
	if !strings.Contains(macFile, "offline") || !strings.Contains(macFile, "not summarized yet") {
		t.Errorf("mac-mini summary = %q", macFile)
	}
	manifest := paths[ProjectManifestPath]
	if !strings.Contains(manifest, "ccm-byte-dev.md\nccm-mac-mini.md") {
		t.Errorf("manifest = %q", manifest)
	}
	for path := range paths {
		if strings.Contains(path, "old") || strings.Contains(path, "assistant") {
			t.Errorf("archived or assistant workspace got a file: %s", path)
		}
	}
}

func TestProjectFilesWriteAsOfAndRedact(t *testing.T) {
	now := time.Date(2026, 11, 16, 2, 0, 0, 0, time.UTC)
	digest := store.WorkspaceDigest{
		WorkspaceID: "ws_1", Name: "renderkit", DeviceLabel: "box", DeviceOnline: true,
		Purpose: "GPU box at 203.0.113.62", Summary: "Login ec2-user@203.0.113.62",
		CompiledAt: "2026-11-15T00:00:00Z",
	}
	files := ProjectFiles([]store.WorkspaceDigest{digest}, nil, nil, now)
	summary := files[0].Content
	for _, secret := range []string{"203.0.113.62", "ec2-user"} {
		if strings.Contains(summary, secret) {
			t.Errorf("project summary holds %q:\n%s", secret, summary)
		}
	}
	if !strings.Contains(summary, "as of 2026-11-16 02:00 UTC") {
		t.Errorf("summary has no as-of line:\n%s", summary)
	}
}
