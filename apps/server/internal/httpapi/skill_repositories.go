package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// skillRepositoryStore is the store capability behind library skills taken
// from git repositories.
type skillRepositoryStore interface {
	CreateSkillRepository(ctx context.Context, repo store.SkillRepository, createdBy string) (store.SkillRepository, error)
	ListSkillRepositories(ctx context.Context) ([]store.SkillRepository, error)
	GetSkillRepository(ctx context.Context, id string) (store.SkillRepository, error)
	RecordSkillRepositoryCheck(ctx context.Context, id, commit, checkErr string) error
	LinkSkillRepositorySkill(ctx context.Context, repositoryID, dir, skillID, commit string) error
	MarkRepositorySkillMissing(ctx context.Context, skillID string) error
	DeleteSkillRepository(ctx context.Context, id string) error
	RecordRepositoryFolders(ctx context.Context, id string, count int) error
	RecordRepositoryDescription(ctx context.Context, id, description string) error
	MarkSkillRepositoryWaiting(ctx context.Context, id string) error
}

func (s *Server) skillRepositories(w http.ResponseWriter) (skillRepositoryStore, bool) {
	repos, ok := s.store.(skillRepositoryStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "skill repositories are not supported by this store")
	}
	return repos, ok
}

// repositoryError answers a failed git operation: the remote's own words,
// as a problem with the request rather than with Foundry. A repository
// whose device is offline is a conflict: it can be read once the device is
// back.
func repositoryError(w http.ResponseWriter, err error) {
	if errors.As(err, &errDeviceOffline{}) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if skillrepo.Unreachable(err) && !strings.Contains(err.Error(), " could not reach ") {
		err = fmt.Errorf("The Foundry server could not reach the repository's host: %w", err)
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

func availableSkills(checkout *skillrepo.Checkout, repo store.SkillRepository) ([]store.RepositorySkillFolder, error) {
	found, err := checkout.FindSkills(repo.Subpath)
	if err != nil {
		return nil, err
	}
	imported := map[string]string{}
	for _, skill := range repo.Skills {
		imported[skill.Dir] = skill.SkillID
	}
	result := make([]store.RepositorySkillFolder, 0, len(found))
	for _, item := range found {
		result = append(result, store.RepositorySkillFolder{
			Dir: item.Dir, Name: item.Name, Description: item.Description, License: item.License, SkillID: imported[item.Dir],
		})
	}
	return result, nil
}

func (s *Server) handleListSkillRepositories(w http.ResponseWriter, r *http.Request) {
	repos, ok := s.skillRepositories(w)
	if !ok {
		return
	}
	items, err := repos.ListSkillRepositories(r.Context())
	writeResult(w, s.withFetchState(items...), err)
}

type repositoryInput struct {
	URL     string `json:"url"`
	Ref     string `json:"ref"`
	Subpath string `json:"subpath"`
	// Mode is "pick" (the default) or "bundle".
	Mode string `json:"mode"`
	// Name names a bundle; it defaults to the repository's name.
	Name string `json:"name"`
	// Dirs, in pick mode, are the skills to add right away.
	Dirs []string `json:"dirs"`
	// Tools, for a bundle, are programs its source does not publish itself.
	Tools []store.SkillToolDeclaration `json:"tools"`
	repositorySourceInput
}

// parsed checks a repository request: remote, label, ref and folder.
func (input repositoryInput) parsed() (remote, label, ref, subpath string, err error) {
	remote, label, err = normalizeRemote(input.URL, input.DeviceID)
	if err != nil {
		return
	}
	ref = strings.TrimSpace(input.Ref)
	if !skillrepo.ValidRef(ref) {
		err = errors.New("enter a branch or tag name, or leave it empty for the default branch")
		return
	}
	subpath, err = skillrepo.CleanSubpath(input.Subpath)
	return
}

// handleAddSkillRepository follows a repository: it must answer and hold at
// least one skill. Both modes take the version the repository follows (its
// branch or tag, else its newest release, else its default branch): picked
// folders (if any) are added at it, a bundle adds every skill.
func (s *Server) handleAddSkillRepository(w http.ResponseWriter, r *http.Request) {
	var input repositoryInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	repos, ok := s.skillRepositories(w)
	if !ok {
		return
	}
	bundles, ok := s.bundles(w)
	if !ok {
		return
	}
	remote, label, ref, subpath, err := input.parsed()
	if err == nil {
		input.Tools, err = checkToolDeclarations(input.Tools)
	}
	if err == nil && len(input.Tools) > 0 && input.Mode != "bundle" {
		err = errors.New("only a bundle installs tools; follow the repository as a bundle")
	}
	if err == nil && input.Registry != "" && !skillrepo.IsNPM(remote) && !slices.ContainsFunc(input.Tools, func(tool store.SkillToolDeclaration) bool { return tool.Source == "npm" }) {
		err = errors.New("only an npm package or a bundle with npm tools uses an npm registry")
	}
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
	if input.Mode == "bundle" {
		s.addSkillBundle(w, r, repos, bundles, input, source, remote, label, ref, subpath)
		return
	}
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
	repo := store.SkillRepository{URL: remote, Label: label, Ref: ref, Subpath: subpath, Commit: checkout.Commit, CheckedAt: time.Now().UTC().Format(time.RFC3339),
		FetchDeviceID: source.FetchDeviceID, FetchDeviceName: source.FetchDeviceName, Registry: source.Registry}
	available, err := availableSkills(checkout, repo)
	if err == nil && len(available) == 0 {
		err = errors.New("no folder with a SKILL.md was found there")
	}
	if err == nil {
		err = checkPickedDirs(label, available, input.Dirs)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	created, err := repos.CreateSkillRepository(r.Context(), repo, accountID(r))
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err := repos.RecordRepositoryFolders(r.Context(), created.ID, len(available)); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.describeRepository(r.Context(), repos, created)
	if len(input.Dirs) > 0 {
		if _, err := s.applyPicked(r.Context(), repos, bundles, created, checkout, version, input.Dirs); err != nil {
			writeResult(w, nil, err)
			return
		}
		s.invalidateProjections()
	}
	created, err = repos.GetSkillRepository(r.Context(), created.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	available, _ = availableSkills(checkout, created)
	writeResultWithStatus(w, http.StatusCreated, store.SkillRepositoryView{Repository: s.withFetchState(created)[0], Available: available}, nil)
}

// checkPickedDirs: every chosen folder is one of the repository's skills,
// with a name sessions can invoke.
func checkPickedDirs(label string, available []store.RepositorySkillFolder, dirs []string) error {
	byDir := map[string]store.RepositorySkillFolder{}
	for _, item := range available {
		byDir[item.Dir] = item
	}
	for _, dir := range dirs {
		item, found := byDir[dir]
		if !found {
			return fmt.Errorf("%s has no skill at %s", label, dir)
		}
		if !skillarchive.ValidInvocationName(item.Name) {
			return fmt.Errorf("%s: %q is not a valid skill name", dir, item.Name)
		}
	}
	return nil
}

func (s *Server) loadSkillRepository(w http.ResponseWriter, r *http.Request) (skillRepositoryStore, store.SkillRepository, bool) {
	repos, ok := s.skillRepositories(w)
	if !ok {
		return nil, store.SkillRepository{}, false
	}
	repo, err := repos.GetSkillRepository(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "skill repository not found")
		return nil, repo, false
	}
	if err != nil {
		writeResult(w, nil, err)
		return nil, repo, false
	}
	return repos, repo, true
}

// handleListRepositorySkills reads the repository again, at the version it
// follows, and lists its skills.
func (s *Server) handleListRepositorySkills(w http.ResponseWriter, r *http.Request) {
	repos, repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	s.repoMu.Lock()
	defer s.repoMu.Unlock()
	reader := s.sourceFor(repo)
	fetchRef, _, _, err := s.bundleTarget(r.Context(), reader, repo.URL, repo.Ref)
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
	available, err := availableSkills(checkout, repo)
	if err == nil {
		err = repos.RecordRepositoryFolders(r.Context(), repo.ID, len(available))
		repo.FoundCount = len(available)
	}
	writeResult(w, store.SkillRepositoryView{Repository: repo, Available: available}, err)
}

// handleImportRepositorySkills adds chosen folders of a picked repository
// to the library, at the version the repository follows; picked skills
// already there move to that version with them. A repository held at an
// earlier version takes no new skills until it is resumed.
func (s *Server) handleImportRepositorySkills(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Dirs []string `json:"dirs"`
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
	switch {
	case len(input.Dirs) == 0:
		writeError(w, http.StatusBadRequest, "choose at least one skill")
		return
	case repo.Mode == "bundle":
		writeError(w, http.StatusConflict, "a bundle always has all of its repository's skills")
		return
	case repo.Paused:
		writeError(w, http.StatusConflict, "this repository's skills are held at an earlier version; resume updates before adding skills")
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
	available, err := availableSkills(checkout, repo)
	if err == nil {
		err = checkPickedDirs(repo.Label, available, input.Dirs)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := s.applyPicked(r.Context(), repos, bundles, repo, checkout, version, input.Dirs); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	updated, err := repos.GetSkillRepository(r.Context(), repo.ID)
	writeResult(w, updated, err)
}

func (s *Server) handleCheckSkillRepository(w http.ResponseWriter, r *http.Request) {
	repos, repo, ok := s.loadSkillRepository(w, r)
	if !ok {
		return
	}
	s.repoMu.Lock()
	err := s.checkSkillRepository(r.Context(), repos, repo)
	s.repoMu.Unlock()
	s.describeRepository(r.Context(), repos, repo)
	// An offline device is not a failure: the check is marked waiting and
	// runs when the device is back, which the repository row says.
	if err != nil && !errors.As(err, &errDeviceOffline{}) {
		repositoryError(w, err)
		return
	}
	updated, err := repos.GetSkillRepository(r.Context(), repo.ID)
	writeResult(w, s.withFetchState(updated)[0], err)
}

func (s *Server) handleDeleteSkillRepository(w http.ResponseWriter, r *http.Request) {
	repos, ok := s.skillRepositories(w)
	if !ok {
		return
	}
	err := repos.DeleteSkillRepository(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "skill repository not found")
		return
	}
	writeResult(w, map[string]string{"id": r.PathValue("id")}, err)
}

// skillRepositoryCheckInterval is how often followed repositories are asked
// for a new version.
const skillRepositoryCheckInterval = 24 * time.Hour

// CheckSkillRepositories moves every followed repository to the version it
// follows once a day until ctx ends.
func (s *Server) CheckSkillRepositories(ctx context.Context) {
	repos, ok := s.store.(skillRepositoryStore)
	if !ok {
		return
	}
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		items, err := repos.ListSkillRepositories(ctx)
		if err != nil {
			log.Printf("skill repository check: %v", err)
		}
		for _, repo := range items {
			s.repoMu.Lock()
			// A repository whose device is offline waits for it to return.
			if err := s.checkSkillRepository(ctx, repos, repo); err != nil && ctx.Err() == nil && !errors.As(err, &errDeviceOffline{}) {
				log.Printf("skill repository check of %s: %v", repo.Label, err)
			}
			if repo.Description == "" {
				s.describeRepository(ctx, repos, repo)
			}
			s.repoMu.Unlock()
		}
		timer.Reset(skillRepositoryCheckInterval)
	}
}

// describeRepository records the repository's own description from its host.
// It is informational: a host that does not answer (rate limit, offline,
// not GitHub) leaves the last description in place. A repository a device
// reads is not described: the server never contacts its host.
func (s *Server) describeRepository(ctx context.Context, repos skillRepositoryStore, repo store.SkillRepository) {
	description, err := s.sourceFor(repo).Describe(ctx, repo.URL)
	if err != nil {
		log.Printf("skill repository %s: reading its description: %v", repo.URL, err)
		return
	}
	if err := repos.RecordRepositoryDescription(ctx, repo.ID, description); err != nil {
		log.Printf("skill repository %s: saving its description: %v", repo.URL, err)
	}
}
