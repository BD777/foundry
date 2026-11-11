package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// wsInstallTool asks a worker to install one tool version; it answers with
// the version now installed.
type wsInstallTool struct {
	Tool store.SkillBundleTool `json:"tool"`
	// Step is "install" (the default), "setup" (the tool's own step after
	// installing), "activate" (make a staged version current) or "remove"
	// (delete a staged version that never became current).
	Step string `json:"step,omitempty"`
	// Activate false stages an install: the version is installed beside
	// the current one, which stays current (a rollout's canary).
	Activate *bool `json:"activate,omitempty"`
	// Archive is a repository tool's folder the server holds, read by
	// another device that can read the upstream; the worker installs from
	// it instead of reading the repository itself.
	Archive *wsToolArchive `json:"archive,omitempty"`
}

type wsToolArchive struct {
	DownloadPath string `json:"downloadPath"`
	SHA256       string `json:"sha256"`
}

type wsFetchRepositoryToolArchive struct {
	Tool       store.SkillBundleTool `json:"tool"`
	UploadPath string                `json:"uploadPath"`
}

type wsRepositoryToolArchiveFetched struct {
	SHA256 string `json:"sha256,omitempty"`
	Error  string `json:"error,omitempty"`
}

type wsToolInstalled struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
	// Output is the end of a setup step's output.
	Output string `json:"output,omitempty"`
}

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
	repo, err := s.store.GetSkillRepository(r.Context(), input.RepositoryID)
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
	value, err := s.installBundleToolOnDevice(r.Context(), deviceID, repo.FetchDeviceID, *tool, step)
	if errors.Is(err, errDeviceToolOffline) {
		writeError(w, http.StatusConflict, "The device is offline; install the tool once it reconnects.")
		return
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
	if err := s.store.SetDeviceToolVersion(r.Context(), deviceID, value.Name, value.Version); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.syncConnectorToolVersions(r.Context())
	s.projectionsChanged("", fieldDeviceTools)
	writeResult(w, value, nil)
}

// errDeviceToolOffline: the device has no daemon connection to install on.
var errDeviceToolOffline = errors.New("the device is offline")

// installBundleToolOnDevice installs (or sets up, or uninstalls) a bundle's
// tool on a device. readerDeviceID is the device that reads the bundle's
// upstream, if one does: it reads a repository tool for the others.
func (s *Server) installBundleToolOnDevice(ctx context.Context, deviceID, readerDeviceID string, tool store.SkillBundleTool, step string) (wsToolInstalled, error) {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return wsToolInstalled{}, errDeviceToolOffline
	}
	payload := wsInstallTool{Tool: tool, Step: step}
	release, err := s.deliverRepositoryTool(ctx, readerDeviceID, deviceID, &payload)
	if err != nil {
		return wsToolInstalled{}, err
	}
	defer release()
	request, err := json.Marshal(payload)
	if err != nil {
		return wsToolInstalled{}, err
	}
	timeout := 10 * time.Minute
	if step == "setup" {
		timeout = 20 * time.Minute
	} else if step == "uninstall" || step == "remove" || step == "activate" {
		timeout = time.Minute
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	value, err := daemonRequest[wsToolInstalled](callCtx, connection, wsInstallToolType, request)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	return value, err
}

// toolArchives holds the folder of a repository tool a reader device read,
// for the one device it is installed on, until that install is over.
type toolArchives struct {
	mu      sync.Mutex
	pending map[string]toolArchive
}

type toolArchive struct {
	deviceID string
	data     []byte
}

func (a *toolArchives) put(deviceID string, data []byte) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending == nil {
		a.pending = map[string]toolArchive{}
	}
	id := uuid.NewString()
	a.pending[id] = toolArchive{deviceID: deviceID, data: data}
	return id
}

func (a *toolArchives) get(id string) (toolArchive, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	archive, ok := a.pending[id]
	return archive, ok
}

func (a *toolArchives) drop(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.pending, id)
}

// deliverRepositoryTool makes a repository tool installable on a device that
// cannot read its upstream (a company machine with no personal GitHub
// sign-in): the reader device reads the tool's folder at the bundle's exact
// commit and uploads it, and the install request points the device at it.
// Anything else is installed as the device itself does. release drops the
// held folder.
func (s *Server) deliverRepositoryTool(ctx context.Context, readerDeviceID, deviceID string, request *wsInstallTool) (func(), error) {
	none := func() {}
	if request.Tool.Source != "repository" || request.Step != "install" || readerDeviceID == "" || readerDeviceID == deviceID {
		return none, nil
	}
	reader := s.hub.connectionFor(readerDeviceID)
	if reader == nil {
		return none, fmt.Errorf("the device that reads this package's upstream is offline (%s); it reads %s for the others once it is back online", readerDeviceID, request.Tool.Name)
	}
	uploadID := s.repoUploads.open(readerDeviceID)
	defer s.repoUploads.close(uploadID)
	payload, err := json.Marshal(wsFetchRepositoryToolArchive{
		Tool: request.Tool, UploadPath: "/api/daemon/skill-repository-fetches/" + uploadID,
	})
	if err != nil {
		return none, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsRepositoryToolArchiveFetched](callCtx, reader, wsFetchRepositoryToolArchiveType, payload)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	if err != nil {
		return none, fmt.Errorf("reading %s through the device that reads its upstream: %w", request.Tool.Name, err)
	}
	data := s.repoUploads.close(uploadID)
	if len(data) == 0 {
		return none, fmt.Errorf("the device that reads %s sent no files", request.Tool.Name)
	}
	id := s.toolArchives.put(deviceID, data)
	request.Archive = &wsToolArchive{DownloadPath: "/api/daemon/repository-tool-archives/" + id, SHA256: value.SHA256}
	return func() { s.toolArchives.drop(id) }, nil
}

// handleDaemonRepositoryToolArchive gives a repository tool's folder to the
// one device it is held for.
func (s *Server) handleDaemonRepositoryToolArchive(w http.ResponseWriter, r *http.Request) {
	archive, ok := s.toolArchives.get(r.PathValue("id"))
	if !ok || !actorFromContext(r.Context()).ActsAsDevice(archive.deviceID) {
		writeError(w, http.StatusNotFound, "no such tool archive")
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	_, _ = w.Write(archive.data)
}
