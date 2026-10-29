package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
)

// Register only a private access mapping. This does not launch a process, probe
// a port range, acquire a lease, share the device or control the application.
func (s *Server) registerServiceForMCP(call mcpCall) (string, error) {
	workspaceID := mcpArgString(call.args, "workspaceId")
	if workspaceID == "" {
		workspaceID = call.actor.Identity.WorkspaceID
	}
	key := mcpArgString(call.args, "registrationKey")
	if key == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("registrationKey is required for safe retries")}
	}
	// Empty: the Server picks https when the port answers TLS, else http.
	protocol := mcpArgString(call.args, "protocol")
	var port int
	if json.Unmarshal(call.args["port"], &port) != nil || port < 1024 || port > 65535 {
		return "", &statusError{http.StatusBadRequest, errors.New("port must be an explicit whole HTTP port")}
	}
	item, err := s.saveServiceTunnel(call.r.Context(), call.actor, workspaceID, "", serviceTunnelInput{
		TargetWorkspaceID: mcpArgString(call.args, "targetWorkspaceId"), Name: mcpArgString(call.args, "name"), Port: int(port), Protocol: protocol, WorkID: mcpArgString(call.args, "workId"), Visibility: "private", Enabled: true, RegistrationKey: key,
	})
	if err != nil {
		return "", err
	}
	_, status := s.liveTunnel(item)
	return encodeJSON(map[string]any{"service": item, "url": s.tunnelURL(item), "status": status, "lifecycle": "mapping only; existing process lifecycle unchanged"})
}
