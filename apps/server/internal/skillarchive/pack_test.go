package skillarchive

import (
	"os"
	"path/filepath"
	"testing"
)

// A packed folder carries its regular files only: a link pointing outside
// the folder must not bring that file along.
func TestPackDirSkipsLinksAndIsDeterministic(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "demo")
	for name, body := range map[string]string{"SKILL.md": "---\nname: demo\n---\n", "scripts/run.sh": "echo hi\n", ".git/config": "x"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(dir, "leak.txt")); err != nil {
		t.Fatal(err)
	}
	first, count, err := PackDir(os.DirFS(root), "demo")
	if err != nil {
		t.Fatal(err)
	}
	index, err := Inspect(first)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range index.Files {
		paths = append(paths, f.Path)
	}
	if count != 2 || len(paths) != 2 || paths[0] != "SKILL.md" || paths[1] != "scripts/run.sh" {
		t.Fatalf("packed %v (count %d), want SKILL.md and scripts/run.sh only", paths, count)
	}
	again, _, _ := PackDir(os.DirFS(root), "demo")
	if string(again) != string(first) {
		t.Fatal("packing the same folder must give the same bytes")
	}
	if _, _, err := PackDir(os.DirFS(root), "demo/scripts"); err == nil {
		t.Fatal("a folder without SKILL.md was packed")
	}
}
