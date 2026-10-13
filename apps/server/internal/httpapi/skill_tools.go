package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
	if err := s.store.SetDeviceToolVersion(r.Context(), deviceID, value.Name, value.Version); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", fieldDeviceTools)
	writeResult(w, value, nil)
}
