// Package skilltools finds the programs a skill bundle needs at a version:
// the commands of its npm package, the downloads its GitHub release
// publishes, and the uv or npm tools it declares, at the versions matching
// the bundle's. Workers install them; the server only names them.
package skilltools

import (
	"context"
	"fmt"
	"regexp"
	"sort"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DeviceRegistry marks an npm tool that installs with each device's own npm
// settings.
const DeviceRegistry = "device"

// Resolver looks up the versions and downloads of a bundle's tools.
type Resolver struct {
	// ReleaseAPI is the GitHub API base used to find a bundle's tool
	// downloads.
	ReleaseAPI string
	// PyPIAPI is the PyPI base used to find the versions of the Python
	// tools bundles declare.
	PyPIAPI string
}

// npmToolSetups are the steps known packages need after installing, run
// only when the person asks: the browsers these CLIs drive are downloaded
// separately from the package.
var npmToolSetups = map[string]store.SkillToolSetup{
	"agent-browser":  {Args: []string{"install"}, Description: "Downloads the browser agent-browser drives (Chrome for Testing)."},
	"playwright-cli": {Command: "playwright", Args: []string{"install", "chromium"}, Description: "Downloads the Chromium build Playwright drives."},
}

// npmTool is one command of an npm package, installed from registry.
// signIn is what a person runs once on each device, in a terminal, after
// installing, as the package declares it (skillrepo.NPMSignIns); Foundry
// shows it and never runs it (it is interactive).
func npmTool(bin, version, pkg, registry string, signIn []string) store.SkillBundleTool {
	tool := store.SkillBundleTool{Name: bin, Version: version, Source: "npm", Package: pkg, Registry: registry}
	if setup, ok := npmToolSetups[bin]; ok {
		tool.Setup = &setup
	}
	tool.SignIn = signIn
	return tool
}

// Registry is where a repository's npm tools install from: its registry,
// else each device's own npm settings when a device reads it (the public
// registry may not have its packages), else the public one.
func Registry(repo store.SkillRepository) string {
	if repo.Registry != "" {
		return repo.Registry
	}
	if repo.FetchDeviceID != "" {
		return DeviceRegistry
	}
	return ""
}

// npmTools are the commands an npm bundle's package installs, at the
// bundle's version.
func npmTools(checkout *skillrepo.Checkout, pkg, version, registry string) []store.SkillBundleTool {
	tools := []store.SkillBundleTool{}
	signIns := skillrepo.NPMSignIns(checkout)
	for _, bin := range skillrepo.NPMBins(checkout, pkg) {
		tools = append(tools, npmTool(bin, version, pkg, registry, signIns[bin]))
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools
}

// BundleTools are the programs a bundle needs at a version: the commands of
// its npm package, or its GitHub release's downloads (the ones found before
// when GitHub does not answer), and the tools it declares. checkout is read
// only for an npm package. A repository a device reads is not looked up on
// GitHub: the server does not contact its host. source reads the
// repository (declared npm tools' versions).
func (r Resolver) BundleTools(ctx context.Context, source skillrepo.Source, repo store.SkillRepository, checkout *skillrepo.Checkout, version string) ([]store.SkillBundleTool, error) {
	var tools []store.SkillBundleTool
	if skillrepo.IsNPM(repo.URL) {
		tools = npmTools(checkout, skillrepo.NPMPackage(repo.URL), checkout.Commit, Registry(repo))
	} else if repo.FetchDeviceID != "" {
		tools = toolsFoundBefore(repo, version)
	} else if detected, err := r.releaseTools(ctx, repo.Label, version); err == nil {
		tools = detected
	} else {
		tools = toolsFoundBefore(repo, version)
	}
	atVersion := repo
	if checkout != nil {
		atVersion.Commit = checkout.Commit
	}
	return r.WithDeclared(ctx, source, atVersion, tools, version)
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

// VersionTools are the programs a bundle needs at one of its recorded
// versions: the ones recorded with it. A version recorded without them
// (before versions held their tools, or while PyPI did not answer) has them
// read again for its tag, as applying it would, and a declared tool PyPI did
// not answer for then is read now.
func (r Resolver) VersionTools(ctx context.Context, source skillrepo.Source, repo store.SkillRepository, version store.SkillBundleVersion) ([]store.SkillBundleTool, error) {
	if len(version.Tools) == 0 && len(repo.Tools) > 0 {
		var checkout *skillrepo.Checkout
		if skillrepo.IsNPM(repo.URL) {
			fetched, err := source.Fetch(ctx, repo.URL, version.Commit)
			if err != nil {
				return repo.Tools, fmt.Errorf("reading the tools of %s: %w", version.Tag, err)
			}
			defer fetched.Close()
			checkout = fetched
		}
		atVersion := repo
		atVersion.Commit = version.Commit
		return r.BundleTools(ctx, source, atVersion, checkout, version.Tag)
	}
	atVersion := repo
	atVersion.Tools = version.Tools
	if UnresolvedDeclared(atVersion) {
		return r.WithDeclared(ctx, source, repo, version.Tools, version.Tag)
	}
	return version.Tools, nil
}

var semverPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+`)

func semverLike(tag string) bool { return semverPattern.MatchString(tag) }
