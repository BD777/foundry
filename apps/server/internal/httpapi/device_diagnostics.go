package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// diagnosticsCapability is declared by workers that report on themselves
// and run repairs on request.
const diagnosticsCapability = "diagnostics"

type wsDiagnosticsReady struct {
	Report *store.DeviceDiagnostics `json:"report,omitempty"`
	Error  string                   `json:"error,omitempty"`
}

type wsRunRepair struct {
	Action string `json:"action"`
}

type wsRepairDone struct {
	Result *store.DeviceRepairResult `json:"result,omitempty"`
	Error  string                    `json:"error,omitempty"`
}

var deviceRepairActions = map[string]bool{
	"forget-missing-workspaces": true,
	"clear-skill-scan-cache":    true,
	"recheck-agents":            true,
}

// diagnosticsConnection is the device's live connection when its worker can
// diagnose itself; otherwise it answers 409 with what to do.
func (s *Server) diagnosticsConnection(w http.ResponseWriter, deviceID string) *daemonConnection {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		writeError(w, http.StatusConflict, "The device is offline; run diagnostics once it reconnects.")
		return nil
	}
	if !connection.hasCapability(diagnosticsCapability) {
		writeError(w, http.StatusConflict, "This device's worker is too old to diagnose itself; update its worker first.")
		return nil
	}
	return connection
}

// handleRunDeviceDiagnostics asks a device's worker for a report on itself:
// its connection, runtime, agents, workspaces and recent log.
func (s *Server) handleRunDeviceDiagnostics(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	connection := s.diagnosticsConnection(w, deviceID)
	if connection == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	value, err := daemonRequest[wsDiagnosticsReady](ctx, connection, wsRunDiagnosticsType, []byte("{}"))
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	if err == nil && value.Report == nil {
		err = errors.New("the worker sent no report")
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "Diagnostics on the device failed: "+err.Error())
		return
	}
	writeResult(w, value.Report, nil)
}

// handleRunDeviceRepair runs one repair the person chose on a device.
func (s *Server) handleRunDeviceRepair(w http.ResponseWriter, r *http.Request) {
	var input wsRunRepair
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !deviceRepairActions[input.Action] {
		writeError(w, http.StatusBadRequest, "unknown repair")
		return
	}
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	connection := s.diagnosticsConnection(w, deviceID)
	if connection == nil {
		return
	}
	request, err := json.Marshal(input)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	value, err := daemonRequest[wsRepairDone](ctx, connection, wsRunRepairType, request)
	if err == nil && value.Error != "" {
		err = errors.New(value.Error)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "The repair on the device failed: "+err.Error())
		return
	}
	s.invalidateProjections()
	writeResult(w, value.Result, nil)
}
