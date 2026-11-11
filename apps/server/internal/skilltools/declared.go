package skilltools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Names a worker accepts for a Python package, a command and a version.
var (
	pypiPackageName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
	toolCommandName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$`)
	toolVersionName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
)

// maxDeclaredTools bounds the programs one bundle declares.
const maxDeclaredTools = 4

// npmToolPackage is an npm package name a declared tool installs.
var npmToolPackage = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]{0,213}$`)

// CheckDeclarations checks the programs a bundle declares: Python packages
// installed with uv, npm packages, or a folder of the bundle's own
// repository, each command once. An npm or uv command defaults to the
// package's name; a repository tool names its command and bins.
func CheckDeclarations(tools []store.SkillToolDeclaration) ([]store.SkillToolDeclaration, error) {
	if len(tools) > maxDeclaredTools {
		return nil, fmt.Errorf("a bundle declares at most %d tools", maxDeclaredTools)
	}
	seen := map[string]bool{}
	clean := make([]store.SkillToolDeclaration, 0, len(tools))
	for _, tool := range tools {
		tool = store.SkillToolDeclaration{
			Source: strings.TrimSpace(tool.Source), Package: strings.TrimSpace(tool.Package),
			Command: strings.TrimSpace(tool.Command), Path: strings.TrimSpace(tool.Path), Bins: tool.Bins,
		}
		if tool.Command == "" && tool.Source != "repository" {
			tool.Command = path.Base(tool.Package)
		}
		switch {
		case tool.Source != "uv" && tool.Source != "npm" && tool.Source != "repository":
			return nil, errors.New(`a declared tool installs with uv, npm or repository`)
		case tool.Source == "npm" && !npmToolPackage.MatchString(tool.Package):
			return nil, fmt.Errorf("%q is not an npm package name", tool.Package)
		case tool.Source == "uv" && !pypiPackageName.MatchString(tool.Package):
			return nil, fmt.Errorf("%q is not a PyPI package name", tool.Package)
		case tool.Source == "repository" && (tool.Package != "" || tool.Path == "" || len(tool.Bins) == 0):
			return nil, errors.New("a repository tool names its path and bins, not a package")
		case !toolCommandName.MatchString(tool.Command):
			return nil, fmt.Errorf("%q is not a command name", tool.Command)
		case seen[tool.Command]:
			return nil, fmt.Errorf("%s is declared twice", tool.Command)
		}
		if tool.Source == "repository" {
			if err := checkDeclarationPath(tool.Path); err != nil {
				return nil, fmt.Errorf("%s path: %w", tool.Command, err)
			}
			if len(tool.Bins) > 32 {
				return nil, fmt.Errorf("%s lists too many bins", tool.Command)
			}
			if _, ok := tool.Bins[tool.Command]; !ok {
				return nil, fmt.Errorf("%s bins includes the command", tool.Command)
			}
			for name, entry := range tool.Bins {
				if !toolCommandName.MatchString(name) {
					return nil, fmt.Errorf("%q is not a command name", name)
				}
				if err := checkDeclarationPath(entry); err != nil {
					return nil, fmt.Errorf("%s bin %s: %w", tool.Command, name, err)
				}
			}
		} else if tool.Path != "" || len(tool.Bins) > 0 {
			return nil, fmt.Errorf("%s names a path or bins without repository source", tool.Command)
		}
		seen[tool.Command] = true
		clean = append(clean, tool)
	}
	return clean, nil
}

func checkDeclarationPath(value string) error {
	if value == "" || len(value) > 300 || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\\x00\r\n") {
		return errors.New("the path must stay inside the repository")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("the path must stay inside the repository")
		}
	}
	return nil
}

// WithDeclared puts a bundle's declared tools into tools, at their versions
// for the bundle's version. A tool PyPI does not answer for is left out,
// and the error names it, so the next check tries again.
func (r Resolver) WithDeclared(ctx context.Context, source skillrepo.Source, repo store.SkillRepository, tools []store.SkillBundleTool, version string) ([]store.SkillBundleTool, error) {
	if len(repo.DeclaredTools) == 0 {
		return tools, nil
	}
	declared := map[string]bool{}
	for _, tool := range repo.DeclaredTools {
		declared[tool.Command] = true
	}
	result := []store.SkillBundleTool{}
	for _, tool := range tools {
		if !declared[tool.Name] {
			result = append(result, tool)
		}
	}
	var problems []error
	for _, tool := range repo.DeclaredTools {
		if tool.Source == "npm" {
			resolved, err := npmToolVersion(ctx, source, tool.Package, version)
			if err != nil {
				problems = append(problems, fmt.Errorf("reading %s's versions on npm: %w", tool.Package, err))
				continue
			}
			result = append(result, npmTool(tool.Command, resolved, tool.Package, Registry(repo), nil))
			continue
		}
		if tool.Source == "repository" {
			commit := repo.Commit
			if commit == "" {
				problems = append(problems, fmt.Errorf("reading %s's repository version: the bundle names no commit", tool.Command))
				continue
			}
			result = append(result, store.SkillBundleTool{
				Name: tool.Command, Version: commit, Source: "repository",
				Repository: repo.URL, Path: tool.Path, Bins: tool.Bins,
			})
			continue
		}
		resolved, err := r.pypiVersion(ctx, tool.Package, version)
		if err != nil {
			problems = append(problems, fmt.Errorf("reading %s's versions on PyPI: %w", tool.Package, err))
			continue
		}
		result = append(result, store.SkillBundleTool{Name: tool.Command, Version: resolved, Source: "uv", Package: tool.Package})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, errors.Join(problems...)
}

// UnresolvedDeclared: a declared tool has no version, because PyPI did not
// answer when the bundle's version was applied.
func UnresolvedDeclared(repo store.SkillRepository) bool {
	for _, declared := range repo.DeclaredTools {
		if !slices.ContainsFunc(repo.Tools, func(tool store.SkillBundleTool) bool { return tool.Name == declared.Command }) {
			return true
		}
	}
	return false
}

// npmToolVersion is the version of a declared npm tool matching a bundle's
// version (a release tag such as v1.2.0) when the package has it, else its
// latest. The repository's reader answers: the device that reads it, with
// its npm settings, or the server.
func npmToolVersion(ctx context.Context, reader skillrepo.Source, pkg, bundleVersion string) (string, error) {
	remote := skillrepo.NPMPrefix + pkg
	if semverLike(bundleVersion) {
		if version, err := reader.Resolve(ctx, remote, strings.TrimPrefix(bundleVersion, "v")); err == nil {
			return version, nil
		}
	}
	return reader.Resolve(ctx, remote, "")
}

// errNoPyPIRelease: PyPI has no (unyanked) release of that name.
var errNoPyPIRelease = errors.New("PyPI has no such release")

// pypiVersion is the version of a PyPI package matching a bundle's version
// (a release tag such as 0.13.11 or v0.13.11) when PyPI has it, so the CLI
// matches its skills; else PyPI's latest release.
func (r Resolver) pypiVersion(ctx context.Context, pkg, bundleVersion string) (string, error) {
	if semverLike(bundleVersion) {
		version, err := r.readPyPI(ctx, pkg+"/"+url.PathEscape(strings.TrimPrefix(bundleVersion, "v")))
		if !errors.Is(err, errNoPyPIRelease) {
			return version, err
		}
	}
	return r.readPyPI(ctx, pkg)
}

// readPyPI reads a project's (or one release's) version from PyPI's JSON
// API.
func (r Resolver) readPyPI(ctx context.Context, project string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, r.PyPIAPI+"/pypi/"+project+"/json", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "", errNoPyPIRelease
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("PyPI answered %s", response.Status)
	}
	var body struct {
		Info struct {
			Version string `json:"version"`
			Yanked  bool   `json:"yanked"`
		} `json:"info"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&body); err != nil {
		return "", err
	}
	if body.Info.Yanked {
		return "", errNoPyPIRelease
	}
	if !toolVersionName.MatchString(body.Info.Version) {
		return "", fmt.Errorf("PyPI named an unusable version %q", body.Info.Version)
	}
	return body.Info.Version, nil
}
