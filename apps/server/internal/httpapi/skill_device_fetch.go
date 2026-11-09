package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/skilltools"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// A repository the server cannot reach (an intranet git host or npm
// registry) is read by one device the person who chose it owns. The worker
// runs git or npm with that device's own settings and credentials; nothing
// secret passes through Foundry. It answers with refs (git ls-remote output,
// or an npm package's dist-tags and versions) over the socket, and uploads
// the files of a version over HTTP: a zip of the skill folders for git, the
// package tarball for npm. Everything after that (versions, revisions,
// rollback, tools) is the same as for a repository the server reads.

type wsReadRepositoryRefs struct {
	Remote string `json:"remote"`
	// Tags asks git for every tag; otherwise Patterns (HEAD, refs/heads/x,
	// refs/tags/x) are asked for. An npm remote ignores both.
	Tags     bool     `json:"tags,omitempty"`
	Patterns []string `json:"patterns,omitempty"`
	// Registry is the npm registry; empty uses the device's npm settings.
	Registry string `json:"registry,omitempty"`
}

type wsRepositoryRefs struct {
	// Refs is `git ls-remote` output.
	Refs string `json:"refs,omitempty"`
	// DistTags and Versions describe an npm package.
	DistTags map[string]string `json:"distTags,omitempty"`
	Versions []string          `json:"versions,omitempty"`
	Error    string            `json:"error,omitempty"`
}

type wsFetchSkillRepository struct {
	Remote string `json:"remote"`
	// Ref is a branch or tag (git) or a version or dist-tag (npm); empty
	// is the default branch or the latest version.
	Ref string `json:"ref,omitempty"`
	// Subpath is the folder skills are looked for in (git).
	Subpath  string `json:"subpath,omitempty"`
	Registry string `json:"registry,omitempty"`
	// UploadPath is where the worker posts the files before it answers.
	UploadPath string `json:"uploadPath"`
}

type wsSkillRepositoryFetched struct {
	// Commit is the commit (git) or version (npm) the files are from.
	Commit string `json:"commit,omitempty"`
	Error  string `json:"error,omitempty"`
}

// errDeviceOffline: the repository's device is not connected, so nothing
// about the repository can be read now.
type errDeviceOffline struct{ name string }

func (e errDeviceOffline) Error() string {
	return fmt.Sprintf("%s is offline; this repository is read through it once it is back online", e.name)
}

// deviceUploads holds the files a worker posts for a fetch, until the
// fetch's answer arrives over the socket.
type deviceUploads struct {
	mu      sync.Mutex
	pending map[string]*deviceUpload
}

type deviceUpload struct {
	deviceID string
	data     []byte
}

func (u *deviceUploads) open(deviceID string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.pending == nil {
		u.pending = map[string]*deviceUpload{}
	}
	id := uuid.NewString()
	u.pending[id] = &deviceUpload{deviceID: deviceID}
	return id
}

func (u *deviceUploads) close(id string) []byte {
	u.mu.Lock()
	defer u.mu.Unlock()
	upload := u.pending[id]
	delete(u.pending, id)
	if upload == nil {
		return nil
	}
	return upload.data
}

func (u *deviceUploads) deviceFor(id string) (string, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	upload, ok := u.pending[id]
	if !ok {
		return "", false
	}
	return upload.deviceID, true
}

func (u *deviceUploads) store(id string, data []byte) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	upload, ok := u.pending[id]
	if ok {
		upload.data = data
	}
	return ok
}

// maxDeviceUpload bounds the files of one fetch: an npm tarball is limited
// like the server's own download.
const maxDeviceUpload = 256 << 20

// handleDaemonSkillRepositoryUpload takes the files of a fetch the server
// asked this device for; any other device, or a fetch nobody waits for, is
// refused.
func (s *Server) handleDaemonSkillRepositoryUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	deviceID, ok := s.repoUploads.deviceFor(id)
	if !ok || !actorFromContext(r.Context()).ActsAsDevice(deviceID) {
		writeError(w, http.StatusNotFound, "no such fetch")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDeviceUpload))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "the files are larger than the limit")
		return
	}
	if !s.repoUploads.store(id, data) {
		writeError(w, http.StatusNotFound, "no such fetch")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deviceSource reads repositories through one device; it is a
// skillrepo.Source like the server's own git and npm readers.
type deviceSource struct {
	s        *Server
	deviceID string
	name     string
	registry string
	subpath  string
}

// sourceFor is what reads a repository: its device, the server's npm reader
// pointed at its registry, or the server's default readers.
func (s *Server) sourceFor(repo store.SkillRepository) skillrepo.Source {
	if repo.FetchDeviceID != "" {
		name := repo.FetchDeviceName
		if name == "" {
			name = repo.FetchDeviceID
		}
		return deviceSource{s: s, deviceID: repo.FetchDeviceID, name: name, registry: repo.Registry, subpath: repo.Subpath}
	}
	if repo.Registry != "" {
		if sources, ok := s.skillRepos.(skillrepo.Sources); ok {
			if npm, ok := sources.NPM.(skillrepo.NPM); ok {
				npm.Registry = repo.Registry
				sources.NPM = npm
				return sources
			}
		}
	}
	return s.skillRepos
}

func (d deviceSource) connection() (*daemonConnection, error) {
	connection := d.s.hub.connectionFor(d.deviceID)
	if connection == nil {
		return nil, errDeviceOffline{name: d.name}
	}
	return connection, nil
}

// failed words a device's error for people: whether the device could not
// reach the host or the host refused it.
func (d deviceSource) failed(remote, message string) error {
	if skillrepo.Unreachable(errors.New(message)) {
		return fmt.Errorf("%s could not reach %s: %s", d.name, skillrepo.Host(remote), message)
	}
	return fmt.Errorf("%s could not read %s: %s", d.name, skillrepo.Host(remote), message)
}

func (d deviceSource) refs(ctx context.Context, request wsReadRepositoryRefs) (wsRepositoryRefs, error) {
	connection, err := d.connection()
	if err != nil {
		return wsRepositoryRefs{}, err
	}
	request.Registry = d.registry
	payload, err := json.Marshal(request)
	if err != nil {
		return wsRepositoryRefs{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsRepositoryRefs](ctx, connection, wsReadRepositoryRefsType, payload)
	if err != nil {
		return value, d.failed(request.Remote, err.Error())
	}
	if value.Error != "" {
		return value, d.failed(request.Remote, value.Error)
	}
	return value, nil
}

func (d deviceSource) Resolve(ctx context.Context, remote, ref string) (string, error) {
	if skillrepo.IsNPM(remote) {
		value, err := d.refs(ctx, wsReadRepositoryRefs{Remote: remote})
		if err != nil {
			return "", err
		}
		return skillrepo.NPMVersion(skillrepo.NPMPackage(remote), value.DistTags, value.Versions, ref)
	}
	patterns := []string{"HEAD"}
	if ref != "" {
		patterns = []string{"refs/heads/" + ref, "refs/tags/" + ref, "refs/tags/" + ref + "^{}"}
	}
	value, err := d.refs(ctx, wsReadRepositoryRefs{Remote: remote, Patterns: patterns})
	if err != nil {
		return "", err
	}
	return skillrepo.ResolveFromRefs(value.Refs, remote, ref)
}

func (d deviceSource) LatestRelease(ctx context.Context, remote string) (string, string, bool, error) {
	if skillrepo.IsNPM(remote) {
		version, err := d.Resolve(ctx, remote, "")
		if err != nil {
			return "", "", false, err
		}
		return version, version, true, nil
	}
	value, err := d.refs(ctx, wsReadRepositoryRefs{Remote: remote, Tags: true})
	if err != nil {
		return "", "", false, err
	}
	return skillrepo.LatestReleaseFromRefs(value.Refs)
}

// Describe: the repository's host is only asked by the device, which has
// no description to give; the server never contacts it.
func (d deviceSource) Describe(context.Context, string) (string, error) { return "", nil }

var (
	gitCommit  = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	npmVersion = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`)
)

// Fetch has the device take a version and upload its files, then unpacks
// them like a checkout the server made.
func (d deviceSource) Fetch(ctx context.Context, remote, ref string) (*skillrepo.Checkout, error) {
	connection, err := d.connection()
	if err != nil {
		return nil, err
	}
	id := d.s.repoUploads.open(d.deviceID)
	defer d.s.repoUploads.close(id)
	payload, err := json.Marshal(wsFetchSkillRepository{
		Remote: remote, Ref: ref, Subpath: d.subpath, Registry: d.registry,
		UploadPath: "/api/daemon/skill-repository-fetches/" + id,
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsSkillRepositoryFetched](ctx, connection, wsFetchSkillRepositoryType, payload)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	if err != nil {
		return nil, d.failed(remote, err.Error())
	}
	data := d.s.repoUploads.close(id)
	if data == nil {
		return nil, fmt.Errorf("%s sent no files for %s", d.name, skillrepo.Host(remote))
	}
	if skillrepo.IsNPM(remote) {
		if !npmVersion.MatchString(value.Commit) {
			return nil, fmt.Errorf("%s named an unusable version %q", d.name, value.Commit)
		}
		return skillrepo.CheckoutFromPackage(data, value.Commit)
	}
	if !gitCommit.MatchString(value.Commit) {
		return nil, fmt.Errorf("%s named an unusable commit %q", d.name, value.Commit)
	}
	return skillrepo.CheckoutFromTree(data, value.Commit)
}

// repositorySourceInput is where a repository is read, as a request names
// it: a device ("" is the server) and an npm registry.
type repositorySourceInput struct {
	DeviceID string `json:"deviceId"`
	Registry string `json:"registry"`
}

var errSkillRepositoryAdminRequired = &statusError{http.StatusForbidden, errors.New(
	"This action needs the instance Admin role.")}

var errSkillRepositorySourceRefused = &statusError{http.StatusForbidden, errors.New(
	"skill repositories are changed only for the person by their own chats and assistant; an Issue's sessions, verifiers and Foundry's own utility sessions cannot change them")}

// checkedSource is the request path's checkedSourceFor.
func (s *Server) checkedSource(w http.ResponseWriter, r *http.Request, input repositorySourceInput, remote string) (store.SkillRepository, bool) {
	manager, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return store.SkillRepository{}, false
	}
	repo, err := s.checkedSourceFor(r.Context(), manager, input, remote)
	if err != nil {
		writeResult(w, nil, err)
		return store.SkillRepository{}, false
	}
	return repo, true
}

// checkedSourceFor checks where a repository is to be read: only the
// caller's own device (or, for an admin, one nobody owns) may read it, and
// an ssh remote needs a device's keys. It returns a repository carrying the
// choice, for sourceFor.
func (s *Server) checkedSourceFor(ctx context.Context, manager providerManager, input repositorySourceInput, remote string) (store.SkillRepository, error) {
	deviceID := strings.TrimSpace(input.DeviceID)
	registry, err := skillrepo.CleanRegistry(input.Registry)
	if err != nil {
		return store.SkillRepository{}, &statusError{http.StatusBadRequest, err}
	}
	if deviceID == "" && skillrepo.IsSSH(remote) {
		return store.SkillRepository{}, &statusError{http.StatusBadRequest, errors.New(
			"an ssh URL is read with a device's own keys; choose a device to read it")}
	}
	repo := store.SkillRepository{FetchDeviceID: deviceID, Registry: registry}
	if deviceID == "" {
		return repo, nil
	}
	allowed := manager.owned[deviceID]
	if !allowed && manager.admin {
		// The page has always let an admin choose a device nobody owns.
		if owner, err := s.store.DeviceOwner(ctx, deviceID); err == nil && owner == "" {
			allowed = true
		}
	}
	if !allowed {
		return repo, &statusError{http.StatusNotFound, errors.New("device not found")}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, deviceID); err != nil {
		return repo, err
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return repo, err
	}
	for _, device := range devices {
		if device.ID == deviceID {
			repo.FetchDeviceName = device.Label
		}
	}
	if repo.FetchDeviceName == "" {
		return repo, &statusError{http.StatusNotFound, errors.New("device not found")}
	}
	return repo, nil
}

// sourceLabel is how people see a repository: an npm package from a private
// registry is named on that registry (or by its name alone, when the
// device's own npm settings choose the registry), not on npmjs.com.
func sourceLabel(remote, label string, source store.SkillRepository) string {
	if !skillrepo.IsNPM(remote) {
		return label
	}
	if source.Registry != "" {
		return strings.TrimPrefix(source.Registry, "https://") + "/" + skillrepo.NPMPackage(remote)
	}
	if source.FetchDeviceID != "" {
		return skillrepo.NPMPackage(remote)
	}
	return label
}

// normalizeRemote reads a repository address: a device may also read ssh
// remotes.
func normalizeRemote(raw, deviceID string) (string, string, error) {
	if strings.TrimSpace(deviceID) != "" {
		return skillrepo.NormalizeDeviceURL(raw)
	}
	return skillrepo.NormalizeURL(raw)
}

// withFetchState says whether each repository's fetch device is connected,
// and where each device stands with each bundle that has tools.
func (s *Server) withFetchState(repos ...store.SkillRepository) []store.SkillRepository {
	for i := range repos {
		if repos[i].FetchDeviceID != "" {
			repos[i].FetchDeviceOnline = s.hub.HasConnection(repos[i].FetchDeviceID)
		}
	}
	return s.withDeviceVersions(context.Background(), repos)
}

// setSkillRepositorySource changes where a repository is read and checks it
// there right away; a device that is offline checks once it is back. The
// route and set_skill_repository_source share this operation.
func (s *Server) setSkillRepositorySource(ctx context.Context, actor Actor, repoID string, input repositorySourceInput) (store.SkillRepository, error) {
	manager, err := s.providerManagerFor(ctx, actor)
	if errors.Is(err, errProviderManagementRefused) {
		return store.SkillRepository{}, errSkillRepositorySourceRefused
	}
	if err != nil {
		return store.SkillRepository{}, err
	}
	if !manager.admin {
		return store.SkillRepository{}, errSkillRepositoryAdminRequired
	}
	repo, err := s.store.GetSkillRepository(ctx, repoID)
	if errors.Is(err, store.ErrNotFound) {
		return store.SkillRepository{}, &statusError{http.StatusNotFound, errors.New("skill repository not found")}
	}
	if err != nil {
		return store.SkillRepository{}, err
	}
	choice, err := s.checkedSourceFor(ctx, manager, input, repo.URL)
	if err != nil {
		return store.SkillRepository{}, err
	}
	if choice.Registry != "" && !skillrepo.IsNPM(repo.URL) && !declaresNPMTools(repo) {
		return store.SkillRepository{}, &statusError{http.StatusBadRequest, errors.New(
			"only an npm package or a bundle with npm tools uses an npm registry")}
	}
	if err := s.store.SetSkillRepositorySource(ctx, repo.ID, choice.FetchDeviceID, choice.Registry); err != nil {
		return store.SkillRepository{}, err
	}
	repo.FetchDeviceID, repo.FetchDeviceName, repo.Registry = choice.FetchDeviceID, choice.FetchDeviceName, choice.Registry
	// npm tools install from where the repository is read now.
	if len(repo.Tools) > 0 {
		for i := range repo.Tools {
			if repo.Tools[i].Source == "npm" {
				repo.Tools[i].Registry = skilltools.Registry(repo)
			}
		}
		if err := s.store.SetBundleTools(ctx, repo.ID, repo.Tools); err != nil {
			return store.SkillRepository{}, err
		}
	}
	if !repo.Paused {
		s.repoMu.Lock()
		err := s.checkSkillRepository(ctx, repo)
		s.repoMu.Unlock()
		if err != nil && !errors.As(err, &errDeviceOffline{}) {
			log.Printf("skill repository %s: checking at its new source: %v", repo.Label, err)
		}
	}
	updated, err := s.store.GetSkillRepository(ctx, repo.ID)
	if err != nil {
		return store.SkillRepository{}, err
	}
	return s.withFetchState(updated)[0], nil
}

// handleSetSkillRepositorySource reads the request and answers the shared
// source change exactly as the route always has.
func (s *Server) handleSetSkillRepositorySource(w http.ResponseWriter, r *http.Request) {
	var input repositorySourceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	repo, err := s.setSkillRepositorySource(r.Context(), actorFromContext(r.Context()), r.PathValue("id"), input)
	writeResult(w, repo, err)
}

func declaresNPMTools(repo store.SkillRepository) bool {
	for _, tool := range repo.DeclaredTools {
		if tool.Source == "npm" {
			return true
		}
	}
	return false
}

// checkWaitingRepositories runs the checks that waited for a device to
// come back online, unless integrations are off.
func (s *Server) checkWaitingRepositories(ctx context.Context, deviceID string) {
	if !s.options.Integrations.On() {
		return
	}
	items, err := s.store.ListSkillRepositories(ctx)
	if err != nil {
		log.Printf("skill repository checks for %s: %v", deviceID, err)
		return
	}
	for _, repo := range items {
		if repo.FetchDeviceID != deviceID || !repo.CheckWaiting {
			continue
		}
		s.repoMu.Lock()
		err := s.checkSkillRepository(ctx, repo)
		s.repoMu.Unlock()
		if err != nil && ctx.Err() == nil {
			log.Printf("skill repository check of %s through %s: %v", repo.Label, deviceID, err)
		}
	}
}
