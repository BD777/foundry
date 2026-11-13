package httpapi

import (
	"context"
	"errors"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Connector Skills: the Skill library bundle that comes with a connector.
// A connector package names its bundle when the person enables it
// (connectors_packages.go); a connector whose own npm tool ships Skills
// declares tool.skills, and its bundle is the one the Skill library follows
// for that package. Sessions that receive the connector get the bundle's
// Skills (sessionPackageSkills); the Connectors pages show the link.

// toolSkillPackage is the npm package whose Skills the connector's tool
// ships, or "" when it declares none.
func toolSkillPackage(descriptor store.ConnectorDescriptor) string {
	if descriptor.Tool.Skills == nil || descriptor.Tool.Source != "npm" {
		return ""
	}
	return descriptor.Tool.Package
}

// toolSkillRepository is the bundle following the connector tool's npm
// package: one whose folder is the declared Skill folder, else one that
// reads the whole package.
func toolSkillRepository(repos []store.SkillRepository, descriptor store.ConnectorDescriptor) (store.SkillRepository, bool) {
	pkg := toolSkillPackage(descriptor)
	if pkg == "" {
		return store.SkillRepository{}, false
	}
	remote, _, err := skillrepo.NormalizeURL("npm:" + pkg)
	if err != nil {
		return store.SkillRepository{}, false
	}
	var whole *store.SkillRepository
	for i := range repos {
		repo := repos[i]
		if repo.URL != remote || repo.Mode != "bundle" {
			continue
		}
		if repo.Subpath == descriptor.Tool.Skills.Path {
			return repo, true
		}
		if repo.Subpath == "" && whole == nil {
			whole = &repos[i]
		}
	}
	if whole != nil {
		return *whole, true
	}
	return store.SkillRepository{}, false
}

// connectorSkillSource is one bundle a received connector brings: its
// repository and, when the descriptor names them, the only Skills it turns
// on by default. A connector package turns on all of its bundle.
type connectorSkillSource struct {
	RepositoryID string
	Default      []string
}

// activeMembers are the members a session gets from this source. Default
// names missing from the bundle are skipped.
func (source connectorSkillSource) activeMembers(members []store.SkillBundleMember) []store.SkillBundleMember {
	if len(source.Default) == 0 {
		return members
	}
	on := make(map[string]bool, len(source.Default))
	for _, name := range source.Default {
		on[name] = true
	}
	active := make([]store.SkillBundleMember, 0, len(source.Default))
	for _, member := range members {
		if on[member.Name] {
			active = append(active, member)
		}
	}
	return active
}

// connectorToolBundles are the bundles of the device-held connectors the
// session receives whose tools ship Skills.
func connectorToolBundles(ctx context.Context, db Backend, devices *connectors.DeviceHeld, deviceID string, kinds map[string]bool) ([]connectorSkillSource, error) {
	if devices == nil || deviceID == "" || len(kinds) == 0 {
		return nil, nil
	}
	var declaring []store.ConnectorDescriptor
	for kind := range kinds {
		descriptor, err := devices.ConnectorOn(ctx, deviceID, kind)
		if errors.Is(err, connectors.ErrUnknownConnector) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if toolSkillPackage(descriptor) != "" {
			declaring = append(declaring, descriptor)
		}
	}
	if len(declaring) == 0 {
		return nil, nil
	}
	repos, err := db.ListSkillRepositories(ctx)
	if err != nil {
		return nil, err
	}
	var sources []connectorSkillSource
	for _, descriptor := range declaring {
		if repo, ok := toolSkillRepository(repos, descriptor); ok {
			sources = append(sources, connectorSkillSource{RepositoryID: repo.ID, Default: descriptor.Tool.Skills.Default})
		}
	}
	return sources, nil
}

// deviceOwnSkillNames are the Skills an agent already finds in the device's
// own folders: the device-level roots (~/…) and this workspace's project
// folders, as the device's last scan reported them. provider narrows them to
// the folders that agent reads; "" takes every such folder (the composer
// serves both agents). A connector's bundle never adds a second Skill of the
// same name: the person installed and keeps that copy, Skills carry no
// version to compare, and two entries only crowd the agent's listing.
func deviceOwnSkillNames(ctx context.Context, db Backend, deviceID, workspacePath, provider string) (map[string]bool, error) {
	if deviceID == "" {
		return nil, nil
	}
	skills, err := db.ListDeviceSkills(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	workspacePath = strings.TrimRight(workspacePath, "/")
	names := map[string]bool{}
	for _, skill := range skills {
		root := strings.TrimRight(skill.Root, "/")
		own := strings.HasPrefix(root, "~/")
		if !own && workspacePath != "" {
			parent := root[:max(0, strings.LastIndex(root, "/"))]
			parent = parent[:max(0, strings.LastIndex(parent, "/"))]
			own = parent == workspacePath
		}
		if own && agentReadsSkillRoot(provider, root) {
			names[strings.ToLower(skill.Name)] = true
		}
	}
	return names, nil
}

// workspaceDeviceOwnSkills is deviceOwnSkillNames for a session of provider
// in workspaceID on deviceID.
func workspaceDeviceOwnSkills(ctx context.Context, db Backend, workspaceID, deviceID, provider string) (map[string]bool, error) {
	workspace, err := db.GetWorkspace(ctx, workspaceID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	return deviceOwnSkillNames(ctx, db, deviceID, workspace.LocalPath, provider)
}

// agentReadsSkillRoot: Claude Code reads .claude/skills; Codex reads
// .codex/skills and .agents/skills.
func agentReadsSkillRoot(provider, root string) bool {
	claude := strings.HasSuffix(root, "/.claude/skills")
	codex := strings.HasSuffix(root, "/.codex/skills") || strings.HasSuffix(root, "/.agents/skills")
	switch provider {
	case "claude":
		return claude
	case "codex":
		return codex
	default:
		return claude || codex
	}
}

func withoutDeviceOwn(refs []store.SessionSkillRef, own map[string]bool) []store.SessionSkillRef {
	if len(own) == 0 {
		return refs
	}
	kept := refs[:0:0]
	for _, ref := range refs {
		if !own[strings.ToLower(ref.Name)] {
			kept = append(kept, ref)
		}
	}
	return kept
}

// connectorSkillBundles describes, for the Connectors pages, the bundle each
// connector brings: the person's enabled package bundle, or the bundle that
// follows its tool's npm package (without RepositoryID when none does yet).
// OnCount is how many of its Skills sessions get: the descriptor's defaults,
// and with workspaceID also the members that workspace selected, less the
// ones it turned off.
func (s *Server) connectorSkillBundles(ctx context.Context, ownerUserID, workspaceID string, descriptors []store.ConnectorDescriptor) ([]store.ConnectorSkillBundle, error) {
	var repos []store.SkillRepository
	var packages []store.ConnectorPackageEnablement
	loaded := false
	load := func() error {
		if loaded {
			return nil
		}
		loaded = true
		var err error
		if repos, err = s.store.ListSkillRepositories(ctx); err != nil {
			return err
		}
		if ownerUserID != "" {
			packages, err = s.store.ListConnectorPackages(ctx, ownerUserID)
		}
		return err
	}
	bundles := []store.ConnectorSkillBundle{}
	for _, descriptor := range descriptors {
		var bundle store.ConnectorSkillBundle
		switch {
		case descriptor.Package != nil:
			if err := load(); err != nil {
				return nil, err
			}
			found := false
			for _, item := range packages {
				if item.Kind != descriptor.Kind {
					continue
				}
				for _, repo := range repos {
					if repo.ID == item.RepositoryID {
						bundle, found = store.ConnectorSkillBundle{Kind: descriptor.Kind, Source: "package", RepositoryID: repo.ID}, true
						break
					}
				}
			}
			if !found {
				continue
			}
		case toolSkillPackage(descriptor) != "":
			if err := load(); err != nil {
				return nil, err
			}
			bundle = store.ConnectorSkillBundle{Kind: descriptor.Kind, Source: "tool", Package: toolSkillPackage(descriptor)}
			if repo, ok := toolSkillRepository(repos, descriptor); ok {
				bundle.RepositoryID = repo.ID
			}
		default:
			continue
		}
		if bundle.RepositoryID != "" {
			var source connectorSkillSource
			if bundle.Source == "tool" {
				source.Default = descriptor.Tool.Skills.Default
			}
			if err := s.describeSkillBundle(ctx, repos, workspaceID, source, &bundle); err != nil {
				return nil, err
			}
		}
		bundles = append(bundles, bundle)
	}
	return bundles, nil
}

func (s *Server) describeSkillBundle(ctx context.Context, repos []store.SkillRepository, workspaceID string, source connectorSkillSource, bundle *store.ConnectorSkillBundle) error {
	for _, repo := range repos {
		if repo.ID != bundle.RepositoryID {
			continue
		}
		bundle.Name = repo.Name
		if bundle.Name == "" {
			bundle.Name = repo.Label
		}
		bundle.Version = repo.Version
		bundle.SkillCount = repo.FoundCount
		versions, err := s.store.ListBundleVersions(ctx, repo.ID)
		if err != nil {
			return err
		}
		if len(versions) == 0 {
			bundle.OnCount = bundle.SkillCount
			return nil
		}
		members := versions[0].Members
		bundle.SkillCount = len(members)
		if bundle.Version == "" {
			bundle.Version = versions[0].Tag
		}
		on := map[string]bool{}
		for _, member := range source.activeMembers(members) {
			on[member.SkillID] = true
		}
		if workspaceID != "" {
			off, err := s.store.ListWorkspaceSkillExclusions(ctx, workspaceID)
			if err != nil {
				return err
			}
			for _, id := range off {
				delete(on, id)
			}
			chosen, err := resolveWorkspaceSkills(ctx, s.store, workspaceID)
			if err != nil {
				return err
			}
			inBundle := map[string]bool{}
			for _, member := range members {
				inBundle[member.SkillID] = true
			}
			for _, ref := range chosen.Refs {
				if inBundle[ref.SkillID] {
					on[ref.SkillID] = true
				}
			}
		}
		bundle.OnCount = len(on)
		return nil
	}
	return nil
}
