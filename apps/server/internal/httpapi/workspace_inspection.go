package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
)

type wsWorkspaceInspectionResult struct {
	Inspection json.RawMessage `json:"inspection"`
	Error      string          `json:"error,omitempty"`
}

func (s *Server) handleWorkspaceInspection(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		http.Error(w, "Workspace device is offline", http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{"workspaceId": workspace.ID, "rescan": r.Method == http.MethodPost})
	result, err := daemonRequest[wsWorkspaceInspectionResult](r.Context(), connection, wsInspectWorkspaceType, payload)
	if err == nil && result.Error != "" {
		err = errors.New(result.Error)
	}
	writeResult(w, result.Inspection, err)
}
