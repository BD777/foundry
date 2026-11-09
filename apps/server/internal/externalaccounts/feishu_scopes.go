package externalaccounts

// The scopes a Foundry Feishu login asks for. Agents reach Feishu through
// feishu-cli and the feishu-cli-* skills of the same release, which
// together cover every feishu-cli domain; so the preset is what that
// feishu-cli release itself asks for with `auth login --recommend` (every
// domain, recommended scopes only), plus the scopes its skills request by
// name. It follows the feishu-cli version Foundry runs (docs/skills.md,
// Bundle 版本): feishu_cli_scopes.json holds one set per release, made by
// scripts/feishu-cli-scopes.sh <tag> from that release's own embedded
// registry with FEISHU_CLI_REMOTE_META=off (v1.44.0 reproduces exactly).
// The v1.41.0 entry is the list Foundry shipped before: its recommended
// scopes reproduce, its skill and approval scopes came from the newer
// skills the library held then and are kept as shipped. A release without a set
// uses the newest one before it, and says so. This is feishu-cli's list,
// not a Feishu catalogue of every scope.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// FeishuPresetName names the preset in the API and the UI.
const FeishuPresetName = "feishu-cli-recommended"

// FeishuCLITool is the command whose version picks the preset.
const FeishuCLITool = "feishu-cli"

//go:embed feishu_cli_scopes.json
var feishuCLIScopesJSON []byte

// feishuScopeSet is the preset of one feishu-cli release.
type feishuScopeSet struct {
	Commit string `json:"commit"`
	// Recommended: `auth login --recommend`.
	Recommended []string `json:"recommended"`
	// Skill: named by the release's skills, auto-approved, not recommended.
	Skill []string `json:"skill"`
	// Approval: named by the skills; a tenant administrator may have to
	// approve them, so a login asks for them only when the person opts in.
	Approval []string `json:"approval"`
}

var (
	feishuScopeSets     map[string]feishuScopeSet
	feishuScopeVersions []string
	loadScopeSets       sync.Once
	toolVersionsMu      sync.RWMutex
	toolVersions        = map[string]string{}
)

// scopeSets reads feishu_cli_scopes.json once, its releases oldest first.
func scopeSets() (map[string]feishuScopeSet, []string) {
	loadScopeSets.Do(func() {
		if err := json.Unmarshal(feishuCLIScopesJSON, &feishuScopeSets); err != nil || len(feishuScopeSets) == 0 {
			panic(fmt.Sprintf("feishu_cli_scopes.json: %v", err))
		}
		for version := range feishuScopeSets {
			feishuScopeVersions = append(feishuScopeVersions, version)
		}
		sort.Slice(feishuScopeVersions, func(i, j int) bool { return versionBefore(feishuScopeVersions[i], feishuScopeVersions[j]) })
	})
	return feishuScopeSets, feishuScopeVersions
}

var versionNumbers = regexp.MustCompile(`\d+`)

// versionBefore orders release tags by their numbers (v1.9.0 < v1.10.0).
func versionBefore(a, b string) bool {
	left, right := versionNumbers.FindAllString(a, -1), versionNumbers.FindAllString(b, -1)
	for i := 0; i < len(left) && i < len(right); i++ {
		x, _ := strconv.Atoi(left[i])
		y, _ := strconv.Atoi(right[i])
		if x != y {
			return x < y
		}
	}
	return len(left) < len(right)
}

// SetToolVersion records the version of a connector's tool Foundry runs
// (the one its devices were moved to); the preset follows it.
func SetToolVersion(tool, version string) {
	toolVersionsMu.Lock()
	defer toolVersionsMu.Unlock()
	if version == "" {
		delete(toolVersions, tool)
		return
	}
	toolVersions[tool] = version
}

func toolVersion(tool string) string {
	toolVersionsMu.RLock()
	defer toolVersionsMu.RUnlock()
	return toolVersions[tool]
}

// FeishuScopeSetVersion is the release whose set the preset uses for a
// feishu-cli version: that release when Foundry has its set, else the
// newest one before it (or the newest one when the version is not known).
func FeishuScopeSetVersion(version string) string {
	sets, versions := scopeSets()
	if _, ok := sets[version]; ok {
		return version
	}
	newest := versions[len(versions)-1]
	if version == "" {
		return newest
	}
	chosen := ""
	for _, known := range versions {
		if versionBefore(known, version) {
			chosen = known
		}
	}
	if chosen == "" {
		return versions[0]
	}
	return chosen
}

// feishuPreset is the set for the feishu-cli version Foundry runs, and
// the release it is for.
func feishuPreset() (feishuScopeSet, string, string) {
	running := toolVersion(FeishuCLITool)
	version := FeishuScopeSetVersion(running)
	sets, _ := scopeSets()
	return sets[version], version, running
}

// FeishuPresetSource says where the preset comes from.
func FeishuPresetSource() string {
	_, version, running := feishuPreset()
	source := "feishu-cli " + version + " auth login --recommend (all domains), plus scopes its feishu-cli-* skills request by name"
	if running != "" && running != version {
		source += "; Foundry runs feishu-cli " + running + ", whose list was not generated yet"
	}
	return source
}

// FeishuPresetScopes is what a login asks for when the person names no
// scopes (offline_access and auth:user.id:read are added on top).
func FeishuPresetScopes(includeApproval bool) []string {
	set, _, _ := feishuPreset()
	scopes := append(append([]string(nil), set.Recommended...), set.Skill...)
	if includeApproval {
		scopes = append(scopes, set.Approval...)
	}
	return scopes
}

// feishuApprovalScopes are the preset's opt-in scopes.
func feishuApprovalScopes() []string {
	set, _, _ := feishuPreset()
	return append([]string(nil), set.Approval...)
}

// FeishuPresetAdded is what the preset for version asks for beyond the
// preset for previous: the scopes a login made for previous may lack.
func FeishuPresetAdded(previous, version string) []string {
	sets, _ := scopeSets()
	before := map[string]bool{}
	old := sets[FeishuScopeSetVersion(previous)]
	for _, scope := range append(append([]string(nil), old.Recommended...), old.Skill...) {
		before[scope] = true
	}
	now := sets[FeishuScopeSetVersion(version)]
	var added []string
	for _, scope := range append(append([]string(nil), now.Recommended...), now.Skill...) {
		if !before[scope] {
			added = append(added, scope)
		}
	}
	sort.Strings(added)
	return added
}

// MissingPresetAdditions is what a Feishu account lacks of the scopes the
// preset gained with the feishu-cli release Foundry runs (over the release
// before it), and that release as people read it ("feishu-cli v1.44.0"):
// a login made earlier asks for them only
// when it is authorized again (docs/skills.md, Bundle 版本). Nothing is
// missing while no device runs feishu-cli from Foundry, or for other
// providers.
func (s *Service) MissingPresetAdditions(account store.ExternalAccount) (string, []string) {
	if account.Provider != "feishu" {
		return "", nil
	}
	_, versions := scopeSets()
	_, version, running := feishuPreset()
	if running == "" {
		return "", nil
	}
	previous := ""
	for _, known := range versions {
		if versionBefore(known, version) {
			previous = known
		}
	}
	label := FeishuCLITool + " " + version
	if previous == "" {
		return label, nil
	}
	granted := map[string]bool{}
	for _, scope := range account.GrantedScopes {
		granted[scope] = true
	}
	var missing []string
	for _, scope := range FeishuPresetAdded(previous, version) {
		if !granted[scope] {
			missing = append(missing, scope)
		}
	}
	return label, missing
}
