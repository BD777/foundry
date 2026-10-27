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

// A device's external model connections (docs/external-connections.md) are
// registered on the device by the gateway's own installer. Its owner may
// check one (a short native conversation that uses model quota, never run
// automatically) or remove one from the Devices page; the worker does both.

// externalConnectionManageCapability: the worker answers
// check_external_connection and remove_external_connection.
const externalConnectionManageCapability = "external_connection_manage_v1"

// A check prepares the helper (up to 15s) and waits up to two minutes for
// the agent's answer.
const externalConnectionCheckTimeout = 150 * time.Second

type wsExternalConnectionRequestPayload struct {
	ProfileID string `json:"profileId"`
}

type externalConnectionCheck struct {
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Message   string `json:"message,omitempty"`
}

type wsExternalConnectionReply struct {
	Result *externalConnectionCheck `json:"result,omitempty"`
	// Registration refreshes the device's profiles with the new state.
	Registration store.DaemonRegistration `json:"registration"`
	Error        string                   `json:"error,omitempty"`
	ErrorCode    string                   `json:"errorCode,omitempty"`
}

var errExternalConnectionUnsupported = &statusError{http.StatusConflict,
	errors.New("update this device's Foundry worker to check or remove external connections from Foundry")}

func (s *Server) handleCheckExternalConnection(w http.ResponseWriter, r *http.Request) {
	deviceID, profileID, ok := s.externalConnectionTarget(w, r)
	if !ok {
		return
	}
	value, err := s.hub.externalConnectionRequest(r.Context(), deviceID, wsCheckExternalConnectionType, profileID, externalConnectionCheckTimeout)
	if err == nil && value.Result == nil {
		err = errors.New("the device did not report a check result")
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", connectionFields...)
	writeResult(w, value.Result, nil)
}

func (s *Server) handleRemoveExternalConnection(w http.ResponseWriter, r *http.Request) {
	deviceID, profileID, ok := s.externalConnectionTarget(w, r)
	if !ok {
		return
	}
	if _, err := s.hub.externalConnectionRequest(r.Context(), deviceID, wsRemoveExternalConnectionType, profileID, 20*time.Second); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", connectionFields...)
	writeResult(w, map[string]any{"removed": true, "profileId": profileID}, nil)
}

// externalConnectionTarget resolves an external connection the device has
// reported. Only that kind is managed here; other profiles keep their own
// flows.
func (s *Server) externalConnectionTarget(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	profileID := strings.TrimSpace(r.PathValue("profileId"))
	if deviceID == "" || profileID == "" {
		writeError(w, http.StatusBadRequest, "device id and connection id are required")
		return "", "", false
	}
	profile, err := s.deviceProfileProjection(r.Context(), deviceID, profileID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "external connection not found on this device")
		return "", "", false
	}
	if err != nil {
		writeResult(w, nil, err)
		return "", "", false
	}
	if profile.ConnectionType != "external" {
		writeError(w, http.StatusBadRequest, "only external connections are checked or removed here")
		return "", "", false
	}
	return deviceID, profileID, true
}

// externalConnectionRequest asks the device to check or remove one external
// connection and stores the registration it answers with.
func (h *DaemonHub) externalConnectionRequest(ctx context.Context, deviceID, requestType, profileID string, timeout time.Duration) (wsExternalConnectionReply, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return wsExternalConnectionReply{}, &statusError{http.StatusConflict, errors.New("connect this device before managing its connections")}
	}
	if !connection.hasCapability(externalConnectionManageCapability) {
		return wsExternalConnectionReply{}, errExternalConnectionUnsupported
	}
	payload, err := json.Marshal(wsExternalConnectionRequestPayload{ProfileID: profileID})
	if err != nil {
		return wsExternalConnectionReply{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	value, err := daemonRequest[wsExternalConnectionReply](ctx, connection, requestType, payload)
	if err != nil {
		return wsExternalConnectionReply{}, err
	}
	if value.Error != "" {
		status := http.StatusBadGateway
		switch value.ErrorCode {
		case "busy", "id_conflict":
			status = http.StatusConflict
		case "not_found":
			status = http.StatusNotFound
		case "invalid_input":
			status = http.StatusBadRequest
		}
		return wsExternalConnectionReply{}, &statusError{status, errors.New(value.Error)}
	}
	if value.Registration.Device.ID != "" {
		if err := connection.syncRegistration(value.Registration); err != nil {
			return wsExternalConnectionReply{}, err
		}
	}
	return value, nil
}
