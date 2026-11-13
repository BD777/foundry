package httpapi

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// connectorKinds are the connectors a session actually receives: server-held
// materials by provider, and device-held connectors only when their login is
// usable. Isolation-only entries do not make their package available.
func connectorKinds(uses []store.ExternalAccountMaterial, devices []store.DeviceConnectorUse) map[string]bool {
	kinds := map[string]bool{}
	for _, material := range uses {
		if material.Provider != "" {
			kinds[material.Provider] = true
		}
	}
	for _, use := range devices {
		if use.Kind != "" && use.Access == "device_login" {
			kinds[use.Kind] = true
		}
	}
	return kinds
}

// sessionPackageSkills resolves the Skill bundles that come with the
// connectors the session receives: the package bundles selected on this
// device, and the bundles that follow a connector tool's own package
// (toolBundles, from connectorToolBundles), limited to the Skills its
// descriptor turns on by default. The returned pins are independent
// of Skill exclusions: a workspace may hide the Skills but the connector's CLI
// still has to be the version paired with the connector.
func sessionPackageSkills(ctx context.Context, db Backend, ownerUserID, deviceID string, kinds map[string]bool, toolBundles []connectorSkillSource) ([]store.SessionSkillRef, []store.SessionToolPin, error) {
	if ownerUserID == "" || deviceID == "" || len(kinds) == 0 {
		return nil, nil, nil
	}
	enabled, err := db.ListConnectorPackages(ctx, ownerUserID)
	if err != nil {
		return nil, nil, err
	}
	var repositories []connectorSkillSource
	seen := map[string]bool{}
	for _, item := range enabled {
		if kinds[item.Kind] && containsDevice(item.Devices, deviceID) && !seen[item.RepositoryID] {
			seen[item.RepositoryID] = true
			repositories = append(repositories, connectorSkillSource{RepositoryID: item.RepositoryID})
		}
	}
	for _, source := range toolBundles {
		if !seen[source.RepositoryID] {
			seen[source.RepositoryID] = true
			repositories = append(repositories, source)
		}
	}
	if len(repositories) == 0 {
		return nil, nil, nil
	}
	reported, err := db.ListDeviceTools(ctx, deviceID)
	if err != nil {
		return nil, nil, err
	}
	installed := installedByDevice(reported)[deviceID]
	var refs []store.SessionSkillRef
	var pins []store.SessionToolPin
	for _, source := range repositories {
		repositoryID := source.RepositoryID
		repo, err := db.GetSkillRepository(ctx, repositoryID)
		if err != nil {
			continue
		}
		versions, err := db.ListBundleVersions(ctx, repositoryID)
		if err != nil || len(versions) == 0 {
			continue
		}
		version, standing, ok := bundleVersionForDevice(repo, versions, installed)
		if !ok {
			version = versions[0]
			standing = store.BundleDeviceVersion{
				Seq: version.Seq, Tag: version.Tag,
				Tools: versionTools(repo, version),
				State: store.DeviceBundleUnknown,
			}
		}
		members, err := db.SkillRevisionRefs(ctx, source.activeMembers(version.Members))
		if err != nil {
			return nil, nil, err
		}
		name := repo.Name
		if name == "" {
			name = repo.Label
		}
		bundle := store.SessionSkillBundle{ID: repo.ID, Name: name, Version: version.Tag}
		for i := range members {
			refs = append(refs, members[i])
			marked := bundle
			refs[len(refs)-1].Bundle = &marked
		}
		for tool, version := range standing.Tools {
			pins = append(pins, store.SessionToolPin{
				Name: tool, Version: version, BundleID: repo.ID,
				Bundle: name, Verified: standing.Verified,
			})
		}
	}
	sort.Slice(refs, func(i, j int) bool {
		return strings.ToLower(refs[i].Name) < strings.ToLower(refs[j].Name)
	})
	sort.Slice(pins, func(i, j int) bool { return pins[i].Name < pins[j].Name })
	return refs, pins, nil
}

func containsDevice(devices []string, deviceID string) bool {
	for _, id := range devices {
		if id == deviceID {
			return true
		}
	}
	return false
}

// workspacePackageSkills is the one decision of which connector package
// Skills a workspace's session on deviceID gets, shared by session dispatch
// and the composer's "/" menu: the connectors the session receives, the
// packages enabled on the device (kinds: connectorKinds, or
// the kinds the Workspace is bound to before a session exists), then the Workspace's own choices and
// exclusions on top (mergePackageSkillRefs). toolBundles are the bundles of
// the received connectors' own tools (connectorToolBundles); deviceOwn names
// the Skills the agent already finds in the device's own folders
// (deviceOwnSkillNames), which keep their place. base is the Workspace's refs
// the package Skills are added to.
func workspacePackageSkills(ctx context.Context, db Backend, ownerUserID, workspaceID, deviceID string, kinds map[string]bool, toolBundles []connectorSkillSource, deviceOwn map[string]bool, base []store.SessionSkillRef) ([]store.SessionSkillRef, []store.SessionToolPin, error) {
	extra, pins, err := sessionPackageSkills(ctx, db, ownerUserID, deviceID, kinds, toolBundles)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve connector package skills: %w", err)
	}
	merged, err := mergePackageSkillRefs(ctx, db, workspaceID, base, withoutDeviceOwn(extra, deviceOwn))
	if err != nil {
		return nil, nil, fmt.Errorf("merge connector package skills: %w", err)
	}
	return merged, pins, nil
}

// mergePackageSkillRefs adds package Skills after Workspace choices. An
// existing name and an explicitly excluded skill win.
func mergePackageSkillRefs(ctx context.Context, db Backend, workspaceID string, refs []store.SessionSkillRef, extra []store.SessionSkillRef) ([]store.SessionSkillRef, error) {
	if len(extra) == 0 {
		return refs, nil
	}
	names := map[string]bool{}
	for _, ref := range refs {
		names[strings.ToLower(ref.Name)] = true
	}
	excluded, err := db.ListWorkspaceSkillExclusions(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	off := map[string]bool{}
	for _, id := range excluded {
		off[id] = true
	}
	for _, ref := range extra {
		name := strings.ToLower(ref.Name)
		if names[name] || off[ref.SkillID] {
			continue
		}
		names[name] = true
		refs = append(refs, ref)
	}
	return refs, nil
}

func mergeToolPins(left, right []store.SessionToolPin) []store.SessionToolPin {
	seen := map[string]bool{}
	result := make([]store.SessionToolPin, 0, len(left)+len(right))
	for _, pin := range append(append([]store.SessionToolPin(nil), left...), right...) {
		key := pin.BundleID + "\x00" + pin.Name + "\x00" + pin.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, pin)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}
