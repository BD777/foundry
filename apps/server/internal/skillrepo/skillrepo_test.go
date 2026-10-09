package skillrepo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeURL(t *testing.T) {
	for raw, want := range map[string]string{
		"anthropics/skills":                        "github.com/anthropics/skills",
		"https://github.com/anthropics/skills.git": "github.com/anthropics/skills",
		"https://gitlab.com/group/sub/repo/":       "gitlab.com/group/sub/repo",
	} {
		if _, label, err := NormalizeURL(raw); err != nil || label != want {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q", raw, label, err, want)
		}
	}
	for _, raw := range []string{"git@github.com:a/b.git", "http://github.com/a/b", "file:///etc", "https://user:pw@github.com/a/b", "ext::sh -c id", "https://github.com/a/b?x=1"} {
		if _, _, err := NormalizeURL(raw); err == nil {
			t.Errorf("NormalizeURL(%q) accepted", raw)
		}
	}
	for _, ref := range []string{"-c", "a..b", "main branch"} {
		if ValidRef(ref) {
			t.Errorf("ValidRef(%q) accepted", ref)
		}
	}
	if _, err := CleanSubpath("../x"); err == nil {
		t.Error("CleanSubpath accepted a path leaving the repository")
	}
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com", "GIT_CONFIG_GLOBAL=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A repository's skills are found, packed without links, and a moved branch
// resolves to its new commit.
func TestFetchFindsAndPacksSkills(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	allowedProtocol = "file"
	t.Cleanup(func() { allowedProtocol = "https" })
	repo := t.TempDir()
	run(t, repo, "init", "--quiet", "--initial-branch=main")
	write(t, filepath.Join(repo, "LICENSE"), "MIT")
	write(t, filepath.Join(repo, "skills/review/SKILL.md"), "---\nname: review\ndescription: Reviews code\nlicense: Apache-2.0\n---\nbody\n")
	write(t, filepath.Join(repo, "skills/notes/SKILL.md"), "---\nname: notes\ndescription: Notes\n---\n")
	write(t, filepath.Join(repo, "skills/notes/nested/SKILL.md"), "---\nname: nested\n---\n")
	if err := os.Symlink("/etc/hostname", filepath.Join(repo, "skills/notes/leak")); err != nil {
		t.Fatal(err)
	}
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "--quiet", "-m", "one")
	remote := "file://" + repo
	ctx := context.Background()
	first, err := Resolve(ctx, remote, "main")
	if err != nil {
		t.Fatal(err)
	}
	if head, _ := Resolve(ctx, remote, ""); head != first {
		t.Fatalf("default branch at %s, main at %s", head, first)
	}
	if _, err := Resolve(ctx, remote, "missing"); err == nil {
		t.Fatal("resolved a branch that does not exist")
	}
	checkout, err := Fetch(ctx, remote, "main")
	if err != nil {
		t.Fatal(err)
	}
	defer checkout.Close()
	if checkout.Commit != first {
		t.Fatalf("checked out %s, want %s", checkout.Commit, first)
	}
	found, err := checkout.FindSkills("skills")
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || found[0].Name != "notes" || found[1].Name != "review" || found[1].License != "Apache-2.0" || found[0].License != "see repository LICENSE" {
		t.Fatalf("found %+v", found)
	}
	pkg, count, err := checkout.Pack("skills/notes")
	if err != nil {
		t.Fatal(err)
	}
	// SKILL.md, nested/SKILL.md, and the link stored as a plain file by
	// core.symlinks=false: its text is the target path, never the target.
	if count != 3 || len(pkg) == 0 {
		t.Fatalf("packed %d files", count)
	}
	write(t, filepath.Join(repo, "skills/review/SKILL.md"), "---\nname: review\n---\nchanged\n")
	run(t, repo, "commit", "--quiet", "-am", "two")
	if second, _ := Resolve(ctx, remote, "main"); second == first {
		t.Fatal("a new commit was not seen")
	}
}

// The newest release is chosen by version, not by name order; an annotated
// tag resolves to its commit; pre-releases count only without a release.
func TestLatestReleaseOrdersVersions(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	allowedProtocol = "file"
	t.Cleanup(func() { allowedProtocol = "https" })
	repo := t.TempDir()
	run(t, repo, "init", "--quiet", "--initial-branch=main")
	write(t, filepath.Join(repo, "a.txt"), "1")
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "--quiet", "-m", "one")
	ctx := context.Background()
	if _, _, ok, err := LatestRelease(ctx, "file://"+repo); err != nil || ok {
		t.Fatalf("a repository without tags has a release: %v %v", ok, err)
	}
	run(t, repo, "tag", "v1.11.0-rc.1")
	if tag, _, ok, _ := LatestRelease(ctx, "file://"+repo); !ok || tag != "v1.11.0-rc.1" {
		t.Fatalf("only a pre-release: got %q", tag)
	}
	run(t, repo, "tag", "v1.9.0")
	write(t, filepath.Join(repo, "a.txt"), "2")
	run(t, repo, "commit", "--quiet", "-am", "two")
	run(t, repo, "tag", "-a", "v1.10.0", "-m", "release")
	head := strings.TrimSpace(run(t, repo, "rev-parse", "HEAD"))
	tag, commit, ok, err := LatestRelease(ctx, "file://"+repo)
	if err != nil || !ok || tag != "v1.10.0" || commit != head {
		t.Fatalf("latest release = %q %q %v %v; want v1.10.0 at %s", tag, commit, ok, err, head)
	}
}
