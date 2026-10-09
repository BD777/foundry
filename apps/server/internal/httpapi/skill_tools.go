package httpapi

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

type githubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

var (
	toolOS = map[string]string{"linux": "linux", "darwin": "darwin", "macos": "darwin", "apple-darwin": "darwin"}
	// Longer names first, so "x86_64" is not read as "x86".
	toolArch = []struct{ token, arch string }{
		{"x86_64", "amd64"}, {"amd64", "amd64"}, {"aarch64", "arm64"}, {"arm64", "arm64"},
	}
	toolArchive  = regexp.MustCompile(`\.(tar\.gz|tgz|zip)$`)
	checksumName = regexp.MustCompile(`(?i)^(checksums?|sha256sums?)(\.txt)?$|(?i)checksums\.txt$`)
)

// toolAssets picks a release's downloads of tool for linux and macOS on
// amd64 and arm64: archives (or bare binaries) named after the tool, the
// platform and the architecture.
func toolAssets(release githubRelease, tool string) ([]store.SkillToolAsset, string) {
	var assets []store.SkillToolAsset
	checksums := ""
	seen := map[string]bool{}
	for _, asset := range release.Assets {
		name := strings.ToLower(asset.Name)
		if checksumName.MatchString(asset.Name) {
			checksums = asset.URL
			continue
		}
		if !strings.HasPrefix(name, strings.ToLower(tool)) || strings.HasSuffix(name, ".sha256") || strings.HasSuffix(name, ".sig") {
			continue
		}
		osName := ""
		for token, value := range toolOS {
			if strings.Contains(name, token) {
				osName = value
			}
		}
		arch := ""
		for _, candidate := range toolArch {
			if strings.Contains(name, candidate.token) {
				arch = candidate.arch
				break
			}
		}
		if osName == "" || arch == "" || seen[osName+"/"+arch] {
			continue
		}
		if !toolArchive.MatchString(name) && strings.Contains(path0(name), ".") {
			continue
		}
		seen[osName+"/"+arch] = true
		assets = append(assets, store.SkillToolAsset{OS: osName, Arch: arch, Name: asset.Name, URL: asset.URL})
	}
	return assets, checksums
}

// path0 is the name after its tool/platform part, to tell a bare binary
// ("tool_linux_amd64") from an unknown file type ("tool_linux_amd64.deb").
func path0(name string) string {
	if i := strings.LastIndexAny(name, "_-"); i >= 0 {
		return name[i+1:]
	}
	return name
}

// detectReleaseTools finds the program a bundle's GitHub repository
// publishes for its release tag: the repository's name, with downloads per
// platform. Repositories elsewhere, branches and releases without matching
// downloads have none.
func (s *Server) detectReleaseTools(ctx context.Context, label, tag string) ([]store.SkillBundleTool, error) {
	owner, repo, ok := strings.Cut(strings.TrimPrefix(label, "github.com/"), "/")
	if !strings.HasPrefix(label, "github.com/") || !ok || strings.Contains(repo, "/") || !semverLike(tag) {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	endpoint := fmt.Sprintf("%s/repos/%s/%s/releases/tags/%s", s.releaseAPI, url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(tag))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %s", response.Status)
	}
	var release githubRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&release); err != nil {
		return nil, err
	}
	assets, checksums := toolAssets(release, repo)
	if len(assets) == 0 {
		return []store.SkillBundleTool{}, nil
	}
	return []store.SkillBundleTool{{Name: repo, Version: tag, Assets: assets, ChecksumsURL: checksums}}, nil
}

// npmToolSetups are the steps known packages need after installing, run
// only when the person asks: the browsers these CLIs drive are downloaded
// separately from the package.
var npmToolSetups = map[string]store.SkillToolSetup{
	"agent-browser":  {Args: []string{"install"}, Description: "Downloads the browser agent-browser drives (Chrome for Testing)."},
	"playwright-cli": {Command: "playwright", Args: []string{"install", "chromium"}, Description: "Downloads the Chromium build Playwright drives."},
}

// npmToolSignIns are the commands known CLIs need a person to run once
// on each device, in a terminal, after installing; Foundry shows them and
// never runs them (they are interactive).
var npmToolSignIns = map[string][]string{
	"bytedcli": {"auth", "login"},
}

// npmTool is one command of an npm package, installed from registry.
func npmTool(bin, version, pkg, registry string) store.SkillBundleTool {
	tool := store.SkillBundleTool{Name: bin, Version: version, Source: "npm", Package: pkg, Registry: registry}
	if setup, ok := npmToolSetups[bin]; ok {
		tool.Setup = &setup
	}
	tool.SignIn = npmToolSignIns[bin]
	return tool
}

// toolRegistry is where a repository's npm tools install from: its
// registry, else each device's own npm settings when a device reads it
// (the public registry may not have its packages), else the public one.
func toolRegistry(repo store.SkillRepository) string {
	if repo.Registry != "" {
		return repo.Registry
	}
	if repo.FetchDeviceID != "" {
		return deviceRegistry
	}
	return ""
}

// npmTools are the commands an npm bundle's package installs, at the
// bundle's version.
func npmTools(checkout *skillrepo.Checkout, pkg, version, registry string) []store.SkillBundleTool {
	tools := []store.SkillBundleTool{}
	for _, bin := range skillrepo.NPMBins(checkout, pkg) {
		tools = append(tools, npmTool(bin, version, pkg, registry))
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools
}

// bundleTools are the programs a bundle needs at a version: the commands of
// its npm package, or its GitHub release's downloads (the ones found before
// when GitHub does not answer), and the tools it declares. checkout is read
// only for an npm package. A repository a device reads is not looked up on
// GitHub: the server does not contact its host.
func (s *Server) bundleTools(ctx context.Context, repo store.SkillRepository, checkout *skillrepo.Checkout, version string) ([]store.SkillBundleTool, error) {
	var tools []store.SkillBundleTool
	if skillrepo.IsNPM(repo.URL) {
		tools = npmTools(checkout, skillrepo.NPMPackage(repo.URL), checkout.Commit, toolRegistry(repo))
	} else if repo.FetchDeviceID != "" {
		tools = toolsFoundBefore(repo, version)
	} else if detected, err := s.detectReleaseTools(ctx, repo.Label, version); err == nil {
		tools = detected
	} else {
		tools = toolsFoundBefore(repo, version)
	}
	return s.withDeclaredTools(ctx, repo, tools, version)
}

// toolsFoundBefore are the tools recorded when a bundle was last on version,
// else its current ones.
func toolsFoundBefore(repo store.SkillRepository, version string) []store.SkillBundleTool {
	for _, recorded := range repo.Versions {
		if recorded.Tag == version && len(recorded.Tools) > 0 {
			return recorded.Tools
		}
	}
	return repo.Tools
}

// versionTools are the programs a bundle needs at one of its recorded
// versions: the ones recorded with it. A version recorded without them
// (before versions held their tools, or while PyPI did not answer) has them
// read again for its tag, as applying it would, and a declared tool PyPI did
// not answer for then is read now.
func (s *Server) versionTools(ctx context.Context, repo store.SkillRepository, version store.SkillBundleVersion) ([]store.SkillBundleTool, error) {
	if len(version.Tools) == 0 && len(repo.Tools) > 0 {
		var checkout *skillrepo.Checkout
		if skillrepo.IsNPM(repo.URL) {
			fetched, err := s.sourceFor(repo).Fetch(ctx, repo.URL, version.Commit)
			if err != nil {
				return repo.Tools, fmt.Errorf("reading the tools of %s: %w", version.Tag, err)
			}
			defer fetched.Close()
			checkout = fetched
		}
		return s.bundleTools(ctx, repo, checkout, version.Tag)
	}
	atVersion := repo
	atVersion.Tools = version.Tools
	if unresolvedDeclaredTools(atVersion) {
		return s.withDeclaredTools(ctx, repo, version.Tools, version.Tag)
	}
	return version.Tools, nil
}

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

// checkToolDeclarations checks the programs a bundle declares: Python
// packages installed with uv or npm packages, each command once. A command
// defaults to the package's name (without its scope).
func checkToolDeclarations(tools []store.SkillToolDeclaration) ([]store.SkillToolDeclaration, error) {
	if len(tools) > maxDeclaredTools {
		return nil, fmt.Errorf("a bundle declares at most %d tools", maxDeclaredTools)
	}
	seen := map[string]bool{}
	clean := make([]store.SkillToolDeclaration, 0, len(tools))
	for _, tool := range tools {
		tool = store.SkillToolDeclaration{Source: strings.TrimSpace(tool.Source), Package: strings.TrimSpace(tool.Package), Command: strings.TrimSpace(tool.Command)}
		if tool.Command == "" {
			tool.Command = path.Base(tool.Package)
		}
		switch {
		case tool.Source != "uv" && tool.Source != "npm":
			return nil, errors.New(`a declared tool installs with uv or npm: set its source to "uv" or "npm" and name its package`)
		case tool.Source == "npm" && !npmToolPackage.MatchString(tool.Package):
			return nil, fmt.Errorf("%q is not an npm package name", tool.Package)
		case tool.Source == "uv" && !pypiPackageName.MatchString(tool.Package):
			return nil, fmt.Errorf("%q is not a PyPI package name", tool.Package)
		case !toolCommandName.MatchString(tool.Command):
			return nil, fmt.Errorf("%q is not a command name", tool.Command)
		case seen[tool.Command]:
			return nil, fmt.Errorf("%s is declared twice", tool.Command)
		}
		seen[tool.Command] = true
		clean = append(clean, tool)
	}
	return clean, nil
}

// withDeclaredTools puts a bundle's declared tools into tools, at their
// versions for the bundle's version. A tool PyPI does not answer for is left
// out, and the error names it, so the next check tries again.
func (s *Server) withDeclaredTools(ctx context.Context, repo store.SkillRepository, tools []store.SkillBundleTool, version string) ([]store.SkillBundleTool, error) {
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
			resolved, err := s.npmToolVersion(ctx, repo, tool.Package, version)
			if err != nil {
				problems = append(problems, fmt.Errorf("reading %s's versions on npm: %w", tool.Package, err))
				continue
			}
			result = append(result, npmTool(tool.Command, resolved, tool.Package, toolRegistry(repo)))
			continue
		}
		resolved, err := s.pypiVersion(ctx, tool.Package, version)
		if err != nil {
			problems = append(problems, fmt.Errorf("reading %s's versions on PyPI: %w", tool.Package, err))
			continue
		}
		result = append(result, store.SkillBundleTool{Name: tool.Command, Version: resolved, Source: "uv", Package: tool.Package})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, errors.Join(problems...)
}

// unresolvedDeclaredTools: a declared tool has no version, because PyPI did
// not answer when the bundle's version was applied.
func unresolvedDeclaredTools(repo store.SkillRepository) bool {
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
func (s *Server) npmToolVersion(ctx context.Context, repo store.SkillRepository, pkg, bundleVersion string) (string, error) {
	reader := s.sourceFor(repo)
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
func (s *Server) pypiVersion(ctx context.Context, pkg, bundleVersion string) (string, error) {
	if semverLike(bundleVersion) {
		version, err := s.readPyPI(ctx, pkg+"/"+url.PathEscape(strings.TrimPrefix(bundleVersion, "v")))
		if !errors.Is(err, errNoPyPIRelease) {
			return version, err
		}
	}
	return s.readPyPI(ctx, pkg)
}

// readPyPI reads a project's (or one release's) version from PyPI's JSON
// API.
func (s *Server) readPyPI(ctx context.Context, project string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.pypiAPI+"/pypi/"+project+"/json", nil)
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

var semverPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+`)

func semverLike(tag string) bool { return semverPattern.MatchString(tag) }

// wsInstallTool asks a worker to install one tool version; it answers with
// the version now installed.
type wsInstallTool struct {
	Tool store.SkillBundleTool `json:"tool"`
	// Step is "install" (the default) or "setup", the tool's own step after
	// installing.
	Step string `json:"step,omitempty"`
}

type wsToolInstalled struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
	// Output is the end of a setup step's output.
	Output string `json:"output,omitempty"`
}

// toolInstallCapability is declared by workers that install tools on request.
const toolInstallCapability = "tool_install"

// toolSourcesCapability is declared by workers that also install npm and uv
// packages and run a tool's setup step.
const toolSourcesCapability = "tool_sources"

// handleInstallDeviceTool installs a bundle's tool on a device, when the
// person asks; Foundry never installs on its own.
func (s *Server) handleInstallDeviceTool(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RepositoryID string `json:"repositoryId"`
		Tool         string `json:"tool"`
		Step         string `json:"step"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	repos, ok := s.skillRepositories(w)
	if !ok {
		return
	}
	repo, err := repos.GetSkillRepository(r.Context(), input.RepositoryID)
	if err != nil {
		writeError(w, http.StatusNotFound, "skill repository not found")
		return
	}
	var tool *store.SkillBundleTool
	for i := range repo.Tools {
		if repo.Tools[i].Name == input.Tool {
			tool = &repo.Tools[i]
		}
	}
	if tool == nil {
		writeError(w, http.StatusNotFound, "this bundle needs no such tool")
		return
	}
	step := strings.TrimSpace(input.Step)
	switch step {
	case "", "install":
		step = "install"
	case "setup":
		if tool.Setup == nil {
			writeError(w, http.StatusBadRequest, tool.Name+" has no setup step")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, `step must be "install" or "setup"`)
		return
	}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		writeError(w, http.StatusConflict, "The device is offline; install the tool once it reconnects.")
		return
	}
	if !connection.hasCapability(toolInstallCapability) {
		writeError(w, http.StatusConflict, "This device's worker is too old to install tools; update its worker first.")
		return
	}
	if ((tool.Source != "" || step == "setup") && !connection.hasCapability(toolSourcesCapability)) ||
		(tool.Registry != "" && !connection.hasCapability(toolRegistryCapability)) {
		writeError(w, http.StatusConflict, "This device's worker cannot install "+tool.Name+" yet; update its worker first.")
		return
	}
	request, err := json.Marshal(wsInstallTool{Tool: *tool, Step: step})
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// A setup step downloads a browser (hundreds of MB); allow it longer.
	timeout := 10 * time.Minute
	if step == "setup" {
		timeout = 20 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	value, err := daemonRequest[wsToolInstalled](ctx, connection, wsInstallToolType, request)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	if err != nil {
		action := "Installing"
		if step == "setup" {
			action = "Setting up"
		}
		writeError(w, http.StatusBadGateway, fmt.Sprintf("%s %s on the device failed: %v", action, tool.Name, err))
		return
	}
	if step == "setup" {
		writeResult(w, value, nil)
		return
	}
	if tools, ok := s.store.(deviceToolStore); ok {
		if err := tools.SetDeviceToolVersion(r.Context(), deviceID, value.Name, value.Version); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	s.invalidateProjections()
	writeResult(w, value, nil)
}
