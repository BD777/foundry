package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// bundleStore is the store capability behind following a repository's
// versions (as one bundle or by picked skills): versions, rollback,
// selections and the tools a bundle needs.
type bundleStore interface {
	RecordBundleVersion(ctx context.Context, repositoryID string, version store.SkillBundleVersion, paused bool) (store.SkillBundleVersion, error)
	GetBundleVersion(ctx context.Context, repositoryID string, seq int) (store.SkillBundleVersion, error)
	SetBundlePaused(ctx context.Context, repositoryID string, paused bool) error
	SetBundleTools(ctx context.Context, repositoryID string, tools []store.SkillBundleTool) error
	RetireRepositorySkill(ctx context.Context, skillID string) error
	ListBundleSelection(ctx context.Context, scope, ownerID string) ([]string, error)
	SetBundleSelection(ctx context.Context, scope, ownerID string, repositoryIDs []string) error
	ResolveBundleSkills(ctx context.Context, repositoryIDs []string) ([]store.SessionSkillRef, error)
	WorkspaceOwner(ctx context.Context, workspaceID string) (string, error)
	SetSkillRepositoryMode(ctx context.Context, repositoryID, mode, name string) error
}

const (
	bundleScopeWorkspace    = "workspace"
	bundleScopeUser         = "user"
	bundleScopeWorkspaceOff = "workspace-off"
)

func (s *Server) bundles(w http.ResponseWriter) (bundleStore, bool) {
	bundles, ok := s.store.(bundleStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "skill bundles are not supported by this store")
	}
	return bundles, ok
}

// bundleTarget is what a bundle follows now: its branch or tag when one is
// set, else the newest release tag, else the default branch. label is the
// version shown for it: the tag, or the branch and short commit.
func (s *Server) bundleTarget(ctx context.Context, source skillrepo.Source, remote, ref string) (fetchRef, commit, label string, err error) {
	if ref == "" {
		tag, tagCommit, ok, err := source.LatestRelease(ctx, remote)
		if err != nil {
			return "", "", "", err
		}
		if ok {
			return tag, tagCommit, tag, nil
		}
	}
	commit, err = source.Resolve(ctx, remote, ref)
	if err != nil {
		return "", "", "", err
	}
	label = shortCommit(commit)
	if ref != "" {
		label = ref + "@" + label
	}
	return ref, commit, label, nil
}

func shortCommit(commit string) string {
	if len(commit) > 7 {
		return commit[:7]
	}
	return commit
}

// suggestBundle: skills that share a name prefix (feishu-cli-docs,
// feishu-cli-mail, …) or that a manifest lists belong together.
func suggestBundle(available []store.RepositorySkillFolder, checkout *skillrepo.Checkout, subpath string) bool {
	if len(available) < 2 {
		return false
	}
	if checkout.HasFile(path.Join(subpath, "manifest.yaml")) || checkout.HasFile(path.Join(subpath, "manifest.json")) {
		return true
	}
	prefix := available[0].Name
	for _, item := range available[1:] {
		for !strings.HasPrefix(item.Name, prefix) && prefix != "" {
			prefix = prefix[:len(prefix)-1]
		}
	}
	return len(strings.TrimRight(prefix, "-_")) >= 4
}

// repositoryName is the last part of a label like github.com/owner/name.
func repositoryName(label string) string {
	return path.Base(label)
}

// handlePreviewSkillRepository reads a repository without following it: the
// skills of the version it would follow, whether they look like one bundle,
// and its latest release.
func (s *Server) handlePreviewSkillRepository(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	input := repositoryInput{URL: query.Get("url"), Ref: query.Get("ref"), Subpath: query.Get("subpath"),
		repositorySourceInput: repositorySourceInput{DeviceID: query.Get("deviceId"), Registry: query.Get("registry")}}
	remote, label, ref, subpath, err := input.parsed()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	source, ok := s.checkedSource(w, r, input.repositorySourceInput, remote)
	if !ok {
		return
	}
	source.Subpath = subpath
	label = sourceLabel(remote, label, source)
	reader := s.sourceFor(source)
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	// Both ways of following take the version the repository follows, so
	// the preview lists that version's skills.
	fetchRef, _, _, err := s.bundleTarget(r.Context(), reader, remote, ref)
	if err != nil {
		repositoryError(w, err)
		return
	}
	release := ""
	if fetchRef != ref {
		release = fetchRef
	}
	checkout, err := reader.Fetch(r.Context(), remote, fetchRef)
	if err != nil {
		repositoryError(w, err)
		return
	}
	defer checkout.Close()
	available, err := availableSkills(checkout, store.SkillRepository{Subpath: subpath})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(available) == 0 {
		writeError(w, http.StatusBadRequest, "no folder with a SKILL.md was found there")
		return
	}
	description, _ := reader.Describe(r.Context(), remote)
	writeResult(w, map[string]any{
		"description":   description,
		"label":         label,
		"name":          repositoryName(label),
		"available":     available,
		"suggestBundle": suggestBundle(available, checkout, subpath),
		"release":       release,
	}, nil)
}

// addSkillBundle follows a repository as one bundle and adds all of its
// skills at the version it follows.
func (s *Server) addSkillBundle(w http.ResponseWriter, r *http.Request, repos skillRepositoryStore, bundles bundleStore, input repositoryInput, source store.SkillRepository, remote, label, ref, subpath string) {
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	reader := s.sourceFor(source)
	fetchRef, _, version, err := s.bundleTarget(r.Context(), reader, remote, ref)
	if err != nil {
		repositoryError(w, err)
		return
	}
	checkout, err := reader.Fetch(r.Context(), remote, fetchRef)
	if err != nil {
		repositoryError(w, err)
		return
	}
	defer checkout.Close()
	found, err := checkout.FindSkills(subpath)
	if err != nil || len(found) == 0 {
		writeError(w, http.StatusBadRequest, "no folder with a SKILL.md was found there")
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = repositoryName(label)
	}
	created, err := repos.CreateSkillRepository(r.Context(), store.SkillRepository{
		URL: remote, Label: label, Ref: ref, Subpath: subpath, Mode: "bundle", Name: name, DeclaredTools: input.Tools,
		FetchDeviceID: source.FetchDeviceID, FetchDeviceName: source.FetchDeviceName, Registry: source.Registry,
	}, accountID(r))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if _, err := s.applyBundle(r.Context(), repos, bundles, created, checkout, version, false); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.describeRepository(r.Context(), repos, created)
	s.invalidateProjections()
	updated, err := repos.GetSkillRepository(r.Context(), created.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	available, _ := availableSkills(checkout, updated)
	writeResultWithStatus(w, http.StatusCreated, store.SkillRepositoryView{Repository: s.withFetchState(updated)[0], Available: available}, nil)
}

// handleSetSkillRepositoryMode turns a repository followed by picking skills
// into a bundle: it takes the version a bundle follows (its branch or tag,
// else the newest release), adds every skill folder, and keeps the skills
// already picked as the same library entries (same id, new revision only
// when their content differs). Turning a bundle back into picking is not
// offered.
func (s *Server) handleSetSkillRepositoryMode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Mode string `json:"mode"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Mode != "bundle" {
		writeError(w, http.StatusBadRequest, `only "bundle" is supported`)
		return
	}
	repos, repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	bundles, ok := s.bundles(w)
	if !ok {
		return
	}
	if repo.Mode == "bundle" {
		writeResult(w, repo, nil)
		return
	}
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	reader := s.sourceFor(repo)
	fetchRef, _, version, err := s.bundleTarget(r.Context(), reader, repo.URL, repo.Ref)
	if err != nil {
		repositoryError(w, err)
		return
	}
	checkout, err := reader.Fetch(r.Context(), repo.URL, fetchRef)
	if err != nil {
		repositoryError(w, err)
		return
	}
	defer checkout.Close()
	if found, err := checkout.FindSkills(repo.Subpath); err != nil || len(found) == 0 {
		writeError(w, http.StatusBadRequest, "no folder with a SKILL.md was found there")
		return
	}
	if _, err := s.applyBundle(r.Context(), repos, bundles, repo, checkout, version, false); err != nil {
		writeResult(w, nil, err)
		return
	}
	name := repo.Name
	if name == "" {
		name = repositoryName(repo.Label)
	}
	if err := bundles.SetSkillRepositoryMode(r.Context(), repo.ID, "bundle", name); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.describeRepository(r.Context(), repos, repo)
	s.invalidateProjections()
	updated, err := repos.GetSkillRepository(r.Context(), repo.ID)
	writeResult(w, updated, err)
}

// applyBundle makes a bundle's skills those of a checkout, as one version:
// new folders are added, changed ones get a revision, folders gone from the
// repository are retired (sessions stop getting them; the library keeps
// them). Renames are a removal and an addition.
func (s *Server) applyBundle(ctx context.Context, repos skillRepositoryStore, bundles bundleStore, repo store.SkillRepository, checkout *skillrepo.Checkout, version string, paused bool) (store.SkillBundleVersion, error) {
	found, err := checkout.FindSkills(repo.Subpath)
	if err != nil {
		return store.SkillBundleVersion{}, err
	}
	if err := repos.RecordRepositoryFolders(ctx, repo.ID, len(found)); err != nil {
		return store.SkillBundleVersion{}, err
	}
	known := map[string]store.SkillRepositorySkill{}
	for _, skill := range repo.Skills {
		known[skill.Dir] = skill
	}
	applied := store.SkillBundleVersion{Tag: version, Commit: checkout.Commit}
	seen := map[string]bool{}
	var problems []string
	for _, folder := range found {
		if !skillarchive.ValidInvocationName(folder.Name) {
			problems = append(problems, fmt.Sprintf("%s: %q is not a valid skill name", folder.Dir, folder.Name))
			continue
		}
		pkg, count, err := checkout.Pack(folder.Dir)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", folder.Dir, err))
			continue
		}
		existing, had := known[folder.Dir]
		skill, created, err := s.store.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{
			DeviceID: store.RepositoryOrigin(repo.ID), Root: repo.Label, DirName: folder.Dir, TargetSkillID: existing.SkillID,
		}, folder.Name, folder.Description, pkg, count)
		if err != nil {
			return applied, err
		}
		if err := repos.LinkSkillRepositorySkill(ctx, repo.ID, folder.Dir, skill.ID, checkout.Commit); err != nil {
			return applied, err
		}
		seen[folder.Dir] = true
		switch {
		case !had || existing.Retired:
			applied.Added = append(applied.Added, skill.Name)
		case created:
			applied.Changed = append(applied.Changed, skill.Name)
		}
		applied.Members = append(applied.Members, store.SkillBundleMember{Dir: folder.Dir, SkillID: skill.ID, Name: skill.Name, Revision: skill.LatestRevision})
	}
	for _, skill := range repo.Skills {
		if seen[skill.Dir] || skill.Retired {
			continue
		}
		if err := bundles.RetireRepositorySkill(ctx, skill.SkillID); err != nil {
			return applied, err
		}
		applied.Removed = append(applied.Removed, skill.Name)
	}
	tools, err := s.bundleTools(ctx, repo, checkout, version)
	if err != nil {
		problems = append(problems, err.Error())
	}
	applied.Tools = tools
	recorded, err := bundles.RecordBundleVersion(ctx, repo.ID, applied, paused)
	if err != nil {
		return recorded, err
	}
	if err := bundles.SetBundleTools(ctx, repo.ID, tools); err != nil {
		return recorded, err
	}
	if len(problems) > 0 {
		_ = repos.RecordSkillRepositoryCheck(ctx, repo.ID, checkout.Commit, strings.Join(problems, "; "))
	}
	return recorded, nil
}

// applyPicked moves a repository's picked skills, with the folders newly
// chosen in it (add), to a checkout as one version: a skill whose content
// changed gets a revision, an unchanged one gets none, and a skill whose
// folder is gone keeps its last revision and is flagged. Workspaces pinned
// to a revision keep it. Nothing else in the repository is taken.
func (s *Server) applyPicked(ctx context.Context, repos skillRepositoryStore, bundles bundleStore, repo store.SkillRepository, checkout *skillrepo.Checkout, version string, add []string) (store.SkillBundleVersion, error) {
	found, err := checkout.FindSkills(repo.Subpath)
	if err != nil {
		_ = repos.RecordSkillRepositoryCheck(ctx, repo.ID, "", err.Error())
		return store.SkillBundleVersion{}, err
	}
	if err := repos.RecordRepositoryFolders(ctx, repo.ID, len(found)); err != nil {
		return store.SkillBundleVersion{}, err
	}
	folders := map[string]skillrepo.Found{}
	for _, folder := range found {
		folders[folder.Dir] = folder
	}
	picked := map[string]store.SkillRepositorySkill{}
	var dirs []string
	for _, skill := range repo.Skills {
		picked[skill.Dir] = skill
		dirs = append(dirs, skill.Dir)
	}
	for _, dir := range add {
		if _, had := picked[dir]; !had {
			picked[dir] = store.SkillRepositorySkill{Dir: dir}
			dirs = append(dirs, dir)
		}
	}
	applied := store.SkillBundleVersion{Tag: version, Commit: checkout.Commit}
	var problems []string
	for _, dir := range dirs {
		existing := picked[dir]
		folder, present := folders[dir]
		switch {
		case !present && existing.SkillID == "":
			problems = append(problems, fmt.Sprintf("%s: no skill there", dir))
			continue
		case !present:
			if !existing.Missing {
				if err := repos.MarkRepositorySkillMissing(ctx, existing.SkillID); err != nil {
					return applied, err
				}
				applied.Missing = append(applied.Missing, existing.Name)
			}
			continue
		case !skillarchive.ValidInvocationName(folder.Name):
			problems = append(problems, fmt.Sprintf("%s: %q is not a valid skill name", dir, folder.Name))
			continue
		}
		pkg, count, err := checkout.Pack(dir)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", dir, err))
			continue
		}
		skill, created, err := s.store.AddPromotedSkillRevision(ctx, store.PromoteSkillInput{
			DeviceID: store.RepositoryOrigin(repo.ID), Root: repo.Label, DirName: dir, TargetSkillID: existing.SkillID,
		}, folder.Name, folder.Description, pkg, count)
		if err != nil {
			return applied, err
		}
		if err := repos.LinkSkillRepositorySkill(ctx, repo.ID, dir, skill.ID, checkout.Commit); err != nil {
			return applied, err
		}
		switch {
		case existing.SkillID == "":
			applied.Added = append(applied.Added, skill.Name)
		case created:
			applied.Changed = append(applied.Changed, skill.Name)
		}
		applied.Members = append(applied.Members, store.SkillBundleMember{Dir: dir, SkillID: skill.ID, Name: skill.Name, Revision: skill.LatestRevision})
	}
	recorded, err := bundles.RecordBundleVersion(ctx, repo.ID, applied, false)
	if err != nil {
		return recorded, err
	}
	if len(problems) > 0 {
		_ = repos.RecordSkillRepositoryCheck(ctx, repo.ID, checkout.Commit, strings.Join(problems, "; "))
	}
	return recorded, nil
}

// checkSkillRepository moves a followed repository to the version it
// follows when that changed: a bundle takes every skill folder, picked
// skills move one by one. A paused (rolled back) repository stays where it
// is, and one with nothing picked has nothing to move. Picked skills from
// before they followed versions take the current one at their first check.
// A declared tool PyPI did not answer for is read again, at the version the
// repository is on.
func (s *Server) checkSkillRepository(ctx context.Context, repos skillRepositoryStore, repo store.SkillRepository) error {
	bundles, ok := s.store.(bundleStore)
	if !ok {
		return errors.New("skill bundles are not supported by this store")
	}
	reader := s.sourceFor(repo)
	fetchRef, commit, version, err := s.bundleTarget(ctx, reader, repo.URL, repo.Ref)
	if errors.As(err, &errDeviceOffline{}) {
		if markErr := repos.MarkSkillRepositoryWaiting(ctx, repo.ID); markErr != nil {
			return markErr
		}
		return err
	}
	if err != nil {
		_ = repos.RecordSkillRepositoryCheck(ctx, repo.ID, "", err.Error())
		return err
	}
	picked := repo.Mode != "bundle"
	if picked && len(repo.Skills) == 0 {
		return repos.RecordSkillRepositoryCheck(ctx, repo.ID, commit, "")
	}
	if repo.Paused || (commit == repo.Commit && len(repo.Versions) > 0) {
		problem := ""
		if unresolvedDeclaredTools(repo) {
			tools, err := s.withDeclaredTools(ctx, repo, repo.Tools, repo.Version)
			if err != nil {
				problem = err.Error()
			}
			if err := bundles.SetBundleTools(ctx, repo.ID, tools); err != nil {
				return err
			}
		}
		return repos.RecordSkillRepositoryCheck(ctx, repo.ID, "", problem)
	}
	checkout, err := reader.Fetch(ctx, repo.URL, fetchRef)
	if err != nil {
		_ = repos.RecordSkillRepositoryCheck(ctx, repo.ID, "", err.Error())
		return err
	}
	defer checkout.Close()
	if picked {
		_, err = s.applyPicked(ctx, repos, bundles, repo, checkout, version, nil)
	} else {
		_, err = s.applyBundle(ctx, repos, bundles, repo, checkout, version, false)
	}
	if err != nil {
		return err
	}
	s.invalidateProjections()
	return nil
}

// handleRollbackSkillBundle returns a followed repository to an earlier
// version's skills and tools and pauses its automatic updates until it is
// resumed. A bundle's skills that were not in that version leave it; picked
// skills that were not (picked later, or gone from the repository) stay as
// they are. Devices are offered the version's tools; nothing installs by
// itself.
func (s *Server) handleRollbackSkillBundle(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Seq int `json:"seq"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	repos, repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	bundles, ok := s.bundles(w)
	if !ok {
		return
	}
	target, err := bundles.GetBundleVersion(r.Context(), repo.ID, input.Seq)
	if err != nil {
		writeError(w, http.StatusNotFound, "that version of the repository is not recorded")
		return
	}
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	applied := store.SkillBundleVersion{Tag: target.Tag, Commit: target.Commit, RolledBack: true}
	keep := map[string]bool{}
	for _, member := range target.Members {
		keep[member.SkillID] = true
		pkg, err := s.store.GetSkillPackage(r.Context(), member.SkillID, member.Revision)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		item, err := s.store.GetPromotedSkill(r.Context(), member.SkillID)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		content, err := skillarchive.ExportStored(pkg.Content, pkg.Checksum)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		skill, created, err := s.store.AddPromotedSkillRevision(r.Context(), store.PromoteSkillInput{
			DeviceID: store.RepositoryOrigin(repo.ID), Root: repo.Label, DirName: member.Dir, TargetSkillID: member.SkillID,
		}, member.Name, item.Description, content, pkg.FileCount)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if err := repos.LinkSkillRepositorySkill(r.Context(), repo.ID, member.Dir, member.SkillID, target.Commit); err != nil {
			writeResult(w, nil, err)
			return
		}
		if created {
			applied.Changed = append(applied.Changed, member.Name)
		}
		applied.Members = append(applied.Members, store.SkillBundleMember{Dir: member.Dir, SkillID: member.SkillID, Name: member.Name, Revision: skill.LatestRevision})
	}
	for _, skill := range repo.Skills {
		if repo.Mode != "bundle" || skill.Retired || keep[skill.SkillID] {
			continue
		}
		if err := bundles.RetireRepositorySkill(r.Context(), skill.SkillID); err != nil {
			writeResult(w, nil, err)
			return
		}
		applied.Removed = append(applied.Removed, skill.Name)
	}
	tools, toolsErr := s.versionTools(r.Context(), repo, target)
	applied.Tools = tools
	if _, err := bundles.RecordBundleVersion(r.Context(), repo.ID, applied, true); err != nil {
		writeResult(w, nil, err)
		return
	}
	if err := bundles.SetBundleTools(r.Context(), repo.ID, tools); err != nil {
		writeResult(w, nil, err)
		return
	}
	if toolsErr != nil {
		_ = repos.RecordSkillRepositoryCheck(r.Context(), repo.ID, "", toolsErr.Error())
	}
	s.invalidateProjections()
	updated, err := repos.GetSkillRepository(r.Context(), repo.ID)
	writeResult(w, updated, err)
}

// handleResumeSkillBundle turns a paused repository's automatic updates back
// on and brings it to the version it follows.
func (s *Server) handleResumeSkillBundle(w http.ResponseWriter, r *http.Request) {
	repos, repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	bundles, ok := s.bundles(w)
	if !ok {
		return
	}
	if err := bundles.SetBundlePaused(r.Context(), repo.ID, false); err != nil {
		writeResult(w, nil, err)
		return
	}
	repo.Paused = false
	s.repoMu.Lock()
	err := s.checkSkillRepository(r.Context(), repos, repo)
	s.repoMu.Unlock()
	if err != nil {
		repositoryError(w, err)
		return
	}
	updated, err := repos.GetSkillRepository(r.Context(), repo.ID)
	writeResult(w, s.withFetchState(updated)[0], err)
}

// handleSetWorkspaceSkillBundles sets the bundles a workspace uses. bundleIds
// is every bundle that should be on: its owner's defaults left out are
// turned off for this workspace, the others are its own selection.
func (s *Server) handleSetWorkspaceSkillBundles(w http.ResponseWriter, r *http.Request) {
	var input struct {
		BundleIDs []string `json:"bundleIds"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	bundles, ok := s.bundles(w)
	if !ok {
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	defaults, err := ownerDefaultBundles(r.Context(), bundles, workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	on := map[string]bool{}
	var selected, off []string
	for _, id := range input.BundleIDs {
		on[id] = true
		if !slices.Contains(defaults, id) {
			selected = append(selected, id)
		}
	}
	for _, id := range defaults {
		if !on[id] {
			off = append(off, id)
		}
	}
	if err := bundles.SetBundleSelection(r.Context(), bundleScopeWorkspace, workspaceID, selected); err != nil {
		writeResult(w, nil, err)
		return
	}
	if err := bundles.SetBundleSelection(r.Context(), bundleScopeWorkspaceOff, workspaceID, off); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	_, ids, _, err := s.bundleProjection(r.Context(), workspaceID)
	writeResult(w, map[string]any{"bundleIds": ids}, err)
}

// ownerDefaultBundles is the default bundles of the person who owns a
// workspace's device.
func ownerDefaultBundles(ctx context.Context, bundles bundleStore, workspaceID string) ([]string, error) {
	owner, err := bundles.WorkspaceOwner(ctx, workspaceID)
	if err != nil || owner == "" {
		return nil, err
	}
	return bundles.ListBundleSelection(ctx, bundleScopeUser, owner)
}

// workspaceBundleSelection is the bundles a workspace selected and the
// owner's default bundles it did not turn off.
func workspaceBundleSelection(ctx context.Context, bundles bundleStore, workspaceID string) (selected, defaults []string, err error) {
	if selected, err = bundles.ListBundleSelection(ctx, bundleScopeWorkspace, workspaceID); err != nil {
		return nil, nil, err
	}
	all, err := ownerDefaultBundles(ctx, bundles, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	off, err := bundles.ListBundleSelection(ctx, bundleScopeWorkspaceOff, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	for _, id := range all {
		if !slices.Contains(off, id) && !slices.Contains(selected, id) {
			defaults = append(defaults, id)
		}
	}
	return selected, defaults, nil
}

// workspaceBundleRefs are the skills of a workspace's bundles and of its
// owner's default bundles.
func workspaceBundleRefs(ctx context.Context, db store.Store, workspaceID string) (selected, defaults []store.SessionSkillRef, err error) {
	bundles, ok := db.(bundleStore)
	if !ok {
		return nil, nil, nil
	}
	ids, defaultIDs, err := workspaceBundleSelection(ctx, bundles, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	if selected, err = bundles.ResolveBundleSkills(ctx, ids); err != nil {
		return nil, nil, err
	}
	defaults, err = bundles.ResolveBundleSkills(ctx, defaultIDs)
	return selected, defaults, err
}

// bundleProjection lists the library's bundles with their current skills,
// the ones a workspace uses (selected or from its owner's defaults), and its
// owner's default bundles.
func (s *Server) bundleProjection(ctx context.Context, workspaceID string) (summaries []store.SkillBundleSummary, on, defaults []string, err error) {
	repos, ok := s.store.(skillRepositoryStore)
	bundles, okBundles := s.store.(bundleStore)
	if !ok || !okBundles {
		return nil, nil, nil, nil
	}
	items, err := repos.ListSkillRepositories(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	for _, repo := range items {
		if repo.Mode != "bundle" {
			continue
		}
		summary := store.SkillBundleSummary{ID: repo.ID, Name: repo.Name, Label: repo.Label, Version: repo.Version, SkillIDs: []string{}}
		for _, skill := range repo.Skills {
			if !skill.Retired {
				summary.SkillIDs = append(summary.SkillIDs, skill.SkillID)
			}
		}
		summaries = append(summaries, summary)
	}
	selected, inherited, err := workspaceBundleSelection(ctx, bundles, workspaceID)
	if err != nil {
		return nil, nil, nil, err
	}
	if defaults, err = ownerDefaultBundles(ctx, bundles, workspaceID); err != nil {
		return nil, nil, nil, err
	}
	return summaries, append(selected, inherited...), defaults, nil
}
