package httpapi

import (
	"cmp"
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A bundle that ships a CLI with its skills is one version on each device
// (docs/skills.md, Bundle 版本): the newest recorded version whose tool
// versions are the ones Foundry installed there. Sessions get that
// version's skills and run that CLI, never "the latest" of one and an
// older other.

// versionTools are the tool versions a recorded bundle version needs, by
// name. A version recorded before versions kept their tools stands for the
// release whose tag is its single tool's version: a GitHub release's tag,
// an npm or PyPI package's version.
func versionTools(repo store.SkillRepository, version store.SkillBundleVersion) map[string]string {
	tools := map[string]string{}
	for _, tool := range version.Tools {
		tools[tool.Name] = tool.Version
	}
	if len(tools) == 0 && len(repo.Tools) == 1 {
		tools[repo.Tools[0].Name] = version.Tag
	}
	return tools
}

// bundleToolsOnDevice are the bundle's tools Foundry installed on a
// device, with their versions; empty when it installed none.
func bundleToolsOnDevice(repo store.SkillRepository, installed map[string]string) map[string]string {
	tools := map[string]string{}
	for _, tool := range repo.Tools {
		if version := installed[tool.Name]; version != "" {
			tools[tool.Name] = version
		}
	}
	return tools
}

// bundleVersionForDevice is the bundle version a device is on: the newest
// recorded version (versions newest first) whose tools the device has at
// the same versions. ok is false when the device has none of the bundle's
// tools from Foundry; then its sessions take the bundle's current skills.
// A device whose versions no record has is "unknown" and gets the newest
// version, which the page shows as not matching.
func bundleVersionForDevice(repo store.SkillRepository, versions []store.SkillBundleVersion, installed map[string]string) (store.SkillBundleVersion, store.BundleDeviceVersion, bool) {
	tools := bundleToolsOnDevice(repo, installed)
	if len(tools) == 0 || len(versions) == 0 {
		return store.SkillBundleVersion{}, store.BundleDeviceVersion{}, false
	}
	standing := store.BundleDeviceVersion{Tools: tools, State: store.DeviceBundleUnknown}
	for index, version := range versions {
		needs := versionTools(repo, version)
		matched := false
		for name, have := range tools {
			want, listed := needs[name]
			if !listed {
				continue
			}
			if want != have {
				matched = false
				break
			}
			matched = true
		}
		if !matched {
			continue
		}
		standing.Seq, standing.Tag = version.Seq, version.Tag
		standing.Verified = version.Check != nil && version.Check.State == store.CheckPassed
		standing.State = store.DeviceBundleBehind
		if index == 0 || sameRelease(repo, versions[0], version) {
			standing.State = store.DeviceBundleCurrent
		}
		return version, standing, true
	}
	return versions[0], standing, true
}

// sameRelease: two recorded versions need the same tools, as a rollback
// to a version and that version do.
func sameRelease(repo store.SkillRepository, a, b store.SkillBundleVersion) bool {
	left, right := versionTools(repo, a), versionTools(repo, b)
	if len(left) != len(right) || len(left) == 0 {
		return false
	}
	for name, version := range left {
		if right[name] != version {
			return false
		}
	}
	return true
}

// installedByDevice is what every device reported Foundry installed, by
// device and tool.
func installedByDevice(tools []store.DeviceTool) map[string]map[string]string {
	installed := map[string]map[string]string{}
	for _, tool := range tools {
		if tool.Version == "" {
			continue
		}
		if installed[tool.DeviceID] == nil {
			installed[tool.DeviceID] = map[string]string{}
		}
		installed[tool.DeviceID][tool.Tool] = tool.Version
	}
	return installed
}

// withDeviceVersions fills in where each device stands with each bundle
// that has tools, for the page.
func (s *Server) withDeviceVersions(ctx context.Context, repos []store.SkillRepository) []store.SkillRepository {
	var reported []store.DeviceTool
	loaded := false
	for i := range repos {
		repo := &repos[i]
		if repo.Mode != "bundle" || len(repo.Tools) == 0 {
			continue
		}
		s.withKeptChecks(repo)
		if !loaded {
			tools, err := s.store.ListDeviceTools(ctx, "")
			if err != nil {
				return repos
			}
			reported, loaded = tools, true
		}
		versions, err := s.store.ListBundleVersions(ctx, repo.ID)
		if err != nil {
			continue
		}
		installed := installedByDevice(reported)
		devices := make([]string, 0, len(installed))
		for device := range installed {
			devices = append(devices, device)
		}
		sort.Strings(devices)
		repo.DeviceVersions = []store.BundleDeviceVersion{}
		for _, device := range devices {
			if _, standing, ok := bundleVersionForDevice(*repo, versions, installed[device]); ok {
				standing.DeviceID = device
				repo.DeviceVersions = append(repo.DeviceVersions, standing)
			}
		}
	}
	return repos
}

// bundleDevicesSeenBy keeps, for someone who is not an Admin, the bundle
// state of their own devices only: other people's devices (names, tool
// versions, check output, a rollout's reason naming its canary) stay with
// the Admins, who run updates.
func bundleDevicesSeenBy(repos []store.SkillRepository, scope accessScope) []store.SkillRepository {
	if scope.admin {
		return repos
	}
	for i := range repos {
		repo := &repos[i]
		if repo.DeviceVersions != nil {
			own := []store.BundleDeviceVersion{}
			for _, device := range repo.DeviceVersions {
				if scope.ownsDevice(device.DeviceID) {
					own = append(own, device)
				}
			}
			repo.DeviceVersions = own
		}
		if repo.Rollout != nil {
			rollout := *repo.Rollout
			rollout.Devices = []store.SkillBundleRolloutDevice{}
			for _, device := range repo.Rollout.Devices {
				if scope.ownsDevice(device.DeviceID) {
					rollout.Devices = append(rollout.Devices, device)
				}
			}
			if !scope.ownsDevice(rollout.CanaryDeviceID) {
				rollout.CanaryDeviceID = ""
			}
			rollout.Error = ""
			repo.Rollout = &rollout
		}
		for j := range repo.Versions {
			if check := repo.Versions[j].Check; check != nil && !scope.ownsDevice(check.DeviceID) {
				repo.Versions[j].Check = &store.SkillBundleCheck{State: check.State, At: check.At, Forced: check.Forced, Steps: []store.SkillBundleCheckStep{}}
			}
		}
	}
	return repos
}

// withBundleDeviceNames names the devices of each bundle's rollout and
// checks as the viewer reads them: by their Foundry name now (a rename,
// else the host name), not the one they had when the rollout started; a
// device that is not the viewer's carries its owner, and two of one
// owner's devices with one name are told apart by the end of their id.
func (s *Server) withBundleDeviceNames(ctx context.Context, repos []store.SkillRepository, scope accessScope) []store.SkillRepository {
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return repos
	}
	labels := map[string]string{}
	for _, device := range devices {
		labels[device.ID] = device.Label
	}
	people := map[string]string{}
	if users, err := s.store.ListUsers(ctx); err == nil {
		for _, user := range users {
			people[user.ID] = cmp.Or(user.DisplayName, user.Username)
		}
	}
	owners := map[string]string{}
	ownerOf := func(id string) string {
		owner, known := owners[id]
		if !known {
			owner, _ = s.store.DeviceOwner(ctx, id)
			owners[id] = owner
		}
		return owner
	}
	alike := map[string]int{}
	for _, device := range devices {
		alike[ownerOf(device.ID)+"\x00"+device.Label]++
	}
	name := func(id, had string) (string, string) {
		label := cmp.Or(labels[id], had, id)
		if alike[ownerOf(id)+"\x00"+labels[id]] > 1 && len(id) > 4 {
			label += " …" + id[len(id)-4:]
		}
		owner := ""
		if !scope.ownsDevice(id) {
			owner = people[ownerOf(id)]
		}
		return label, owner
	}
	for i := range repos {
		repo := &repos[i]
		if repo.Rollout != nil {
			rollout := *repo.Rollout
			rollout.Devices = append([]store.SkillBundleRolloutDevice(nil), repo.Rollout.Devices...)
			for j := range rollout.Devices {
				rollout.Devices[j].DeviceName, rollout.Devices[j].Owner = name(rollout.Devices[j].DeviceID, rollout.Devices[j].DeviceName)
			}
			repo.Rollout = &rollout
		}
		for j := range repo.Versions {
			if check := repo.Versions[j].Check; check != nil && check.DeviceID != "" {
				named := *check
				named.DeviceName, _ = name(check.DeviceID, check.DeviceName)
				repo.Versions[j].Check = &named
			}
		}
	}
	return repos
}

// deviceSkillRefs moves the bundle skills among refs to the version each
// bundle is on on deviceID, and names the tool versions its sessions run
// (pins). A bundle on its newest version keeps refs as they are. Of an
// older version's skills a workspace gets the ones it gets now (not
// turned off, no name taken by another skill) and the ones the bundle has
// dropped since.
func deviceSkillRefs(ctx context.Context, db Backend, refs []store.SessionSkillRef, deviceID string) ([]store.SessionSkillRef, []store.SessionToolPin, error) {
	if deviceID == "" {
		return refs, nil, nil
	}
	bundles := []string{}
	seen := map[string]bool{}
	for _, ref := range refs {
		if ref.Bundle != nil && !seen[ref.Bundle.ID] {
			seen[ref.Bundle.ID] = true
			bundles = append(bundles, ref.Bundle.ID)
		}
	}
	if len(bundles) == 0 {
		return refs, nil, nil
	}
	reported, err := db.ListDeviceTools(ctx, deviceID)
	if err != nil {
		return nil, nil, err
	}
	installed := installedByDevice(reported)[deviceID]
	var pins []store.SessionToolPin
	replaced := map[string][]store.SessionSkillRef{}
	for _, id := range bundles {
		repo, err := db.GetSkillRepository(ctx, id)
		if err != nil || len(repo.Tools) == 0 {
			continue
		}
		versions, err := db.ListBundleVersions(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		version, standing, ok := bundleVersionForDevice(repo, versions, installed)
		if !ok {
			continue
		}
		name := repo.Name
		if name == "" {
			name = repo.Label
		}
		for tool, toolVersion := range standing.Tools {
			pins = append(pins, store.SessionToolPin{Name: tool, Version: toolVersion, BundleID: repo.ID, Bundle: name, Verified: standing.Verified})
		}
		if standing.State == store.DeviceBundleUnknown || version.Seq == versions[0].Seq || len(version.Members) == 0 {
			continue
		}
		older, err := db.SkillRevisionRefs(ctx, version.Members)
		if err != nil {
			return nil, nil, err
		}
		replaced[id] = pinnedMembers(refs, repo, older, version.Tag)
	}
	sort.Slice(pins, func(i, j int) bool { return pins[i].Name < pins[j].Name })
	if len(replaced) == 0 {
		return refs, pins, nil
	}
	result := make([]store.SessionSkillRef, 0, len(refs))
	placed := map[string]bool{}
	for _, ref := range refs {
		members, swap := []store.SessionSkillRef(nil), false
		if ref.Bundle != nil {
			members, swap = replaced[ref.Bundle.ID]
		}
		if !swap {
			result = append(result, ref)
			continue
		}
		if !placed[ref.Bundle.ID] {
			placed[ref.Bundle.ID] = true
			result = append(result, members...)
		}
	}
	return result, pins, nil
}

// pinnedMembers are an older bundle version's skills as a workspace gets
// them, each marked with the bundle at that version.
func pinnedMembers(refs []store.SessionSkillRef, repo store.SkillRepository, older []store.SessionSkillRef, tag string) []store.SessionSkillRef {
	var bundle store.SessionSkillBundle
	current := map[string]bool{}
	taken := map[string]bool{}
	for _, ref := range refs {
		if ref.Bundle != nil && ref.Bundle.ID == repo.ID {
			bundle = *ref.Bundle
			current[ref.SkillID] = true
			continue
		}
		taken[strings.ToLower(ref.Name)] = true
	}
	active := map[string]bool{}
	for _, skill := range repo.Skills {
		if !skill.Retired {
			active[skill.SkillID] = true
		}
	}
	bundle.Version = tag
	members := []store.SessionSkillRef{}
	for _, ref := range older {
		if taken[strings.ToLower(ref.Name)] || (active[ref.SkillID] && !current[ref.SkillID]) {
			continue
		}
		marked := bundle
		ref.Bundle = &marked
		members = append(members, ref)
	}
	return members
}

// newestInstalled is, per tool, the newest version Foundry installed on any
// device: the version a connector that follows its tool goes by.
func newestInstalled(tools []store.DeviceTool) map[string]string {
	newest := map[string]string{}
	for _, tool := range tools {
		if tool.Version != "" && (newest[tool.Tool] == "" || versionLess(newest[tool.Tool], tool.Version)) {
			newest[tool.Tool] = tool.Version
		}
	}
	return newest
}

// versionLess orders version names by their numbers (v1.9.0 < v1.10.0).
func versionLess(a, b string) bool {
	left, right := versionDigits.FindAllString(a, -1), versionDigits.FindAllString(b, -1)
	for i := 0; i < len(left) && i < len(right); i++ {
		x, _ := strconv.Atoi(left[i])
		y, _ := strconv.Atoi(right[i])
		if x != y {
			return x < y
		}
	}
	return len(left) < len(right)
}

var versionDigits = regexp.MustCompile(`\d+`)

// syncConnectorToolVersions tells the connectors which tool versions the
// devices run now.
func (s *Server) syncConnectorToolVersions(ctx context.Context) {
	if s.connectors == nil {
		return
	}
	tools, err := s.store.ListDeviceTools(ctx, "")
	if err != nil {
		return
	}
	s.connectors.SetToolVersions(newestInstalled(tools))
}
