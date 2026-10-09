package httpapi

import (
	"context"
	"path"
	"slices"
	"testing"
)

// A device scans its own skill folders and each of its workspaces' skill
// folders, where skills are drafted before they are published.
func TestDeviceScanIncludesItsWorkspacesSkillFolders(t *testing.T) {
	fixture := setupProjectedSessionFixture(t)
	paths, err := fixture.server.scanPaths(context.Background(), fixture.deviceID)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range append(append([]string(nil), defaultSkillRoots...),
		path.Join(fixture.workspace.LocalPath, ".agents/skills"),
		path.Join(fixture.workspace.LocalPath, ".claude/skills"),
		path.Join(fixture.workspace.LocalPath, ".codex/skills"),
	) {
		if !slices.Contains(paths, want) {
			t.Fatalf("scan paths %v miss %s", paths, want)
		}
	}
	other, err := fixture.server.scanPaths(context.Background(), "dev_other")
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != len(defaultSkillRoots) {
		t.Fatalf("another device scans this one's workspace: %v", other)
	}
}
