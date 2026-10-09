// Package skillrepo reads skills from public git repositories: the server
// asks git for a branch's commit, fetches that commit shallowly, and finds the
// folders holding a SKILL.md. Only https remotes are used, without any of
// the host's git configuration or credentials.
package skillrepo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
)

// ErrGitMissing means the server has no git program.
var ErrGitMissing = errors.New("git is not installed on the Foundry server")

// allowedProtocol is the only transport git may use; tests switch it to
// "file" to read local repositories.
var allowedProtocol = "https"

var shorthand = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// NormalizeURL accepts "owner/repo" (GitHub), an https URL or an npm package
// ("npm:<name>"), and returns the remote and a short label such as
// "github.com/owner/repo".
func NormalizeURL(raw string) (remote, label string, err error) {
	raw = strings.TrimSpace(raw)
	if IsNPM(raw) {
		return normalizeNPM(raw)
	}
	if shorthand.MatchString(raw) {
		raw = "https://github.com/" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", "", fmt.Errorf("use owner/repo or an https:// git URL without credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", fmt.Errorf("the git URL must not carry a query or fragment")
	}
	repoPath := strings.TrimSuffix(strings.Trim(parsed.Path, "/"), ".git")
	if repoPath == "" {
		return "", "", fmt.Errorf("the git URL names no repository")
	}
	parsed.Path = "/" + repoPath
	return parsed.String(), parsed.Host + "/" + repoPath, nil
}

var refPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)

// ValidRef reports whether ref is a usable branch or tag name; "" means the
// repository's default branch.
func ValidRef(ref string) bool {
	return ref == "" || (refPattern.MatchString(ref) && !strings.HasPrefix(ref, "-") && !strings.Contains(ref, ".."))
}

// CleanSubpath checks the folder within the repository to look in.
func CleanSubpath(sub string) (string, error) {
	sub = strings.Trim(strings.TrimSpace(sub), "/")
	if sub == "" {
		return "", nil
	}
	clean := path.Clean(sub)
	if clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsAny(clean, "\\\x00") {
		return "", fmt.Errorf("the folder must stay inside the repository")
	}
	return clean, nil
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return "", ErrGitMissing
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	home, err := os.MkdirTemp("", "foundry-git-home-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(home)
	full := append([]string{
		"-c", "protocol.allow=never", "-c", "protocol." + allowedProtocol + ".allow=always",
		"-c", "core.symlinks=false", "-c", "credential.helper=",
	}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Dir = dir
	cmd.Env = []string{
		"HOME=" + home, "PATH=" + os.Getenv("PATH"),
		"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ALLOW_PROTOCOL=" + allowedProtocol, "GIT_ASKPASS=/bin/false", "SSH_ASKPASS=/bin/false",
	}
	if proxy := os.Getenv("HTTPS_PROXY"); proxy != "" {
		cmd.Env = append(cmd.Env, "HTTPS_PROXY="+proxy)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if len(message) > 400 {
			message = message[:400]
		}
		return "", fmt.Errorf("git %s: %s", args[0], firstNonEmpty(message, err.Error()))
	}
	return string(out), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// Resolve asks the remote which commit ref (or its default branch) is at,
// without downloading the repository. A branch wins over a tag of the same
// name; an annotated tag resolves to its commit.
func Resolve(ctx context.Context, remote, ref string) (string, error) {
	patterns := []string{"HEAD"}
	if ref != "" {
		patterns = []string{"refs/heads/" + ref, "refs/tags/" + ref, "refs/tags/" + ref + "^{}"}
	}
	out, err := git(ctx, "", append([]string{"ls-remote", "--", remote}, patterns...)...)
	if err != nil {
		return "", err
	}
	return ResolveFromRefs(out, remote, ref)
}

// ResolveFromRefs picks ref's commit (or HEAD's, for "") from `git
// ls-remote` output, the way Resolve does.
func ResolveFromRefs(out, remote, ref string) (string, error) {
	byRef := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if fields := strings.Fields(line); len(fields) == 2 {
			byRef[fields[1]] = fields[0]
		}
	}
	order := []string{"HEAD"}
	if ref != "" {
		order = []string{"refs/heads/" + ref, "refs/tags/" + ref + "^{}", "refs/tags/" + ref}
	}
	for _, name := range order {
		if commit := byRef[name]; commit != "" {
			return commit, nil
		}
	}
	if ref == "" {
		return "", fmt.Errorf("%s has no default branch", remote)
	}
	return "", fmt.Errorf("%s has no branch or tag %q", remote, ref)
}

// semverTag matches release tags such as v1.9.0, 1.10.2 or v2.0.0-rc.1.
var semverTag = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)

type tagVersion struct {
	name       string
	commit     string
	numbers    [3]int
	prerelease string
}

func parseTag(name, commit string) (tagVersion, bool) {
	match := semverTag.FindStringSubmatch(name)
	if match == nil {
		return tagVersion{}, false
	}
	version := tagVersion{name: name, commit: commit, prerelease: match[4]}
	for i := 0; i < 3; i++ {
		version.numbers[i], _ = strconv.Atoi(match[i+1])
	}
	return version, true
}

// newer orders versions; a release is newer than its pre-releases.
func (v tagVersion) newer(other tagVersion) bool {
	for i := 0; i < 3; i++ {
		if v.numbers[i] != other.numbers[i] {
			return v.numbers[i] > other.numbers[i]
		}
	}
	if (v.prerelease == "") != (other.prerelease == "") {
		return v.prerelease == ""
	}
	return v.prerelease > other.prerelease
}

// LatestRelease names the highest version tag of a remote (v1.10.0 is newer
// than v1.9.0) and the commit it points at. Pre-releases count only when the
// remote has no release. ok is false when it has no version tags.
func LatestRelease(ctx context.Context, remote string) (tag, commit string, ok bool, err error) {
	out, err := git(ctx, "", "ls-remote", "--tags", "--", remote)
	if err != nil {
		return "", "", false, err
	}
	return LatestReleaseFromRefs(out)
}

// LatestReleaseFromRefs picks the newest version tag from "<sha> <ref>" lines
// (`git ls-remote --tags` or `git show-ref --tags -d` output).
func LatestReleaseFromRefs(out string) (tag, commit string, ok bool, err error) {
	commits := map[string]string{}
	peeled := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || !strings.HasPrefix(fields[1], "refs/tags/") {
			continue
		}
		name := strings.TrimPrefix(fields[1], "refs/tags/")
		if strings.HasSuffix(name, "^{}") {
			peeled[strings.TrimSuffix(name, "^{}")] = fields[0]
		} else {
			commits[name] = fields[0]
		}
	}
	var best, bestPre *tagVersion
	for name, sha := range commits {
		if peeledSHA, ok := peeled[name]; ok {
			sha = peeledSHA
		}
		version, ok := parseTag(name, sha)
		if !ok {
			continue
		}
		target := &best
		if version.prerelease != "" {
			target = &bestPre
		}
		if *target == nil || version.newer(**target) {
			copy := version
			*target = &copy
		}
	}
	if best == nil {
		best = bestPre
	}
	if best == nil {
		return "", "", false, nil
	}
	return best.name, best.commit, true, nil
}

// Checkout is a shallow copy of one commit; Close removes it.
type Checkout struct {
	Dir    string
	Commit string
}

func (c *Checkout) Close() { _ = os.RemoveAll(c.Dir) }

// Git is the real git transport; Server code depends on the Source
// interface so tests can stand in a local folder.
type Git struct{}

func (Git) Resolve(ctx context.Context, remote, ref string) (string, error) {
	return Resolve(ctx, remote, ref)
}

func (Git) Fetch(ctx context.Context, remote, ref string) (*Checkout, error) {
	return Fetch(ctx, remote, ref)
}

func (Git) LatestRelease(ctx context.Context, remote string) (string, string, bool, error) {
	return LatestRelease(ctx, remote)
}

// Source reads repositories.
type Source interface {
	Resolve(ctx context.Context, remote, ref string) (string, error)
	Fetch(ctx context.Context, remote, ref string) (*Checkout, error)
	// LatestRelease names the highest version tag and its commit.
	LatestRelease(ctx context.Context, remote string) (tag, commit string, ok bool, err error)
	// Describe returns the repository's own description, or "".
	Describe(ctx context.Context, remote string) (string, error)
}

// Fetch downloads the files of ref (or the default branch) at depth one.
func Fetch(ctx context.Context, remote, ref string) (*Checkout, error) {
	dir, err := os.MkdirTemp("", "foundry-skill-repo-")
	if err != nil {
		return nil, err
	}
	checkout := &Checkout{Dir: dir}
	args := []string{"clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	if _, err := git(ctx, "", append(args, "--", remote, dir)...); err != nil {
		checkout.Close()
		return nil, err
	}
	commit, err := git(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		checkout.Close()
		return nil, err
	}
	checkout.Commit = strings.TrimSpace(commit)
	return checkout, nil
}

// Found is one skill folder in a checkout.
type Found struct {
	// Dir is the folder relative to the repository root.
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Description string `json:"description"`
	License     string `json:"license,omitempty"`
}

// maxDepth bounds how deep below the subpath skills are looked for.
const maxDepth = 4

// FindSkills lists the folders under sub that hold a SKILL.md. A skill
// folder's own subfolders are not searched further.
func (c *Checkout) FindSkills(sub string) ([]Found, error) {
	root := filepath.Join(c.Dir, filepath.FromSlash(sub))
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("the repository has no folder %q", sub)
	}
	repoFS := os.DirFS(c.Dir)
	start := "."
	if sub != "" {
		start = sub
	}
	var found []Found
	err = fs.WalkDir(repoFS, start, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if entry.Name() == ".git" || strings.Count(strings.TrimPrefix(p, start), "/") > maxDepth {
			return fs.SkipDir
		}
		manifestInfo, err := fs.Stat(repoFS, path.Join(p, "SKILL.md"))
		if err != nil || !manifestInfo.Mode().IsRegular() {
			return nil
		}
		text, err := fs.ReadFile(repoFS, path.Join(p, "SKILL.md"))
		if err != nil {
			return err
		}
		manifest, _ := skillarchive.ReadManifest(string(text))
		name := manifest.Name
		if name == "" {
			name = path.Base(p)
		}
		found = append(found, Found{Dir: p, Name: name, Description: manifest.Description, License: firstNonEmpty(manifest.License, c.licenseFile(p))})
		return fs.SkipDir
	})
	sort.Slice(found, func(i, j int) bool { return found[i].Dir < found[j].Dir })
	return found, err
}

// licenseFile names the license file covering a skill folder: its own, or
// the repository's.
func (c *Checkout) licenseFile(dir string) string {
	for _, folder := range []string{dir, "."} {
		for _, name := range []string{"LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"} {
			if info, err := os.Stat(filepath.Join(c.Dir, filepath.FromSlash(folder), name)); err == nil && info.Mode().IsRegular() {
				if folder == "." {
					return "see repository " + name
				}
				return "see " + name
			}
		}
	}
	return ""
}

// HasFile reports whether the checkout has a regular file at rel.
func (c *Checkout) HasFile(rel string) bool {
	if _, err := CleanSubpath(rel); err != nil || rel == "" {
		return false
	}
	info, err := os.Lstat(filepath.Join(c.Dir, filepath.FromSlash(rel)))
	return err == nil && info.Mode().IsRegular()
}

// Pack zips one skill folder of the checkout.
func (c *Checkout) Pack(dir string) ([]byte, int, error) {
	if _, err := CleanSubpath(dir); err != nil || dir == "" {
		return nil, 0, fmt.Errorf("invalid skill folder %q", dir)
	}
	return skillarchive.PackDir(os.DirFS(c.Dir), dir)
}
