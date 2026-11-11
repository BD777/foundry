package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Connector extensions on the person's own devices, at their click only
// (docs/connector-extensions.md, "来源"): install or update one from the
// git folder it is published in, or remove one. The device fetches the
// folder with its own git credentials; the server never holds an
// extension's code.

const extensionInstallTimeout = 6 * time.Minute

var extensionIDPath = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

type extensionInstallInput struct {
	Source             *store.ConnectorExtensionRepository `json:"source,omitempty"`
	BundledExtensionID string                              `json:"bundledExtensionId,omitempty"`
}

type extensionAutoUpdateInput struct {
	AutoUpdate bool `json:"autoUpdate"`
}

// ownOnlineDevice checks the caller owns the path's device and it can be
// asked now; it writes the refusal otherwise.
func (s *Server) ownOnlineDevice(w http.ResponseWriter, r *http.Request) (string, bool) {
	if _, ok := personActor(w, r); !ok {
		return "", false
	}
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return "", false
	}
	if !scope.ownsDevice(deviceID) {
		writeError(w, http.StatusNotFound, "device not found")
		return "", false
	}
	if err := store.RequireDeviceAvailable(r.Context(), s.store, deviceID); err != nil {
		writeResult(w, nil, err)
		return "", false
	}
	return deviceID, true
}

func (s *Server) askDeviceExtension(ctx context.Context, deviceID string, payload store.ExtensionRequestPayload) (store.ExtensionReplyPayload, error) {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return store.ExtensionReplyPayload{}, errConnectorDeviceOffline
	}
	request, err := json.Marshal(payload)
	if err != nil {
		return store.ExtensionReplyPayload{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, extensionInstallTimeout)
	defer cancel()
	reply, err := daemonRequest[store.ExtensionReplyPayload](ctx, connection, wsExtensionRequestType, request)
	if err == nil && reply.Error != "" {
		err = errors.New(reply.Error)
	}
	return reply, err
}

// handleInstallDeviceExtension installs (or updates) an extension on the
// device from a git folder.
func (s *Server) handleInstallDeviceExtension(w http.ResponseWriter, r *http.Request) {
	deviceID, ok := s.ownOnlineDevice(w, r)
	if !ok {
		return
	}
	var input extensionInstallInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	input.BundledExtensionID = strings.TrimSpace(input.BundledExtensionID)
	if (input.Source == nil) == (input.BundledExtensionID == "") {
		writeError(w, http.StatusBadRequest, "choose a bundled extension or a repository source")
		return
	}
	if input.BundledExtensionID != "" && !extensionIDPath.MatchString(input.BundledExtensionID) {
		writeError(w, http.StatusBadRequest, "not an extension id")
		return
	}
	if input.Source != nil {
		input.Source.Git = strings.TrimSpace(input.Source.Git)
		input.Source.Path = strings.Trim(strings.TrimSpace(input.Source.Path), "/")
		input.Source.Ref = strings.TrimSpace(input.Source.Ref)
		if err := connectors.CheckExtensionRepository(*input.Source); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	reply, err := s.askDeviceExtension(r.Context(), deviceID, store.ExtensionRequestPayload{
		Action: "install", Source: input.Source, BundledExtensionID: input.BundledExtensionID,
	})
	if err != nil {
		writeDeviceConnectorError(w, "Installing the extension", err)
		return
	}
	s.visibilityChanged(r.Context(), deviceID)
	writeJSON(w, http.StatusOK, reply)
}

// handleRemoveDeviceExtension removes an extension from the device, with
// its private data and the model providers it gave.
func (s *Server) handleRemoveDeviceExtension(w http.ResponseWriter, r *http.Request) {
	deviceID, ok := s.ownOnlineDevice(w, r)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("extensionId"))
	if !extensionIDPath.MatchString(id) {
		writeError(w, http.StatusBadRequest, "not an extension id")
		return
	}
	reply, err := s.askDeviceExtension(r.Context(), deviceID, store.ExtensionRequestPayload{Action: "remove", ExtensionID: id})
	if err != nil {
		writeDeviceConnectorError(w, "Removing the extension", err)
		return
	}
	s.visibilityChanged(r.Context(), deviceID)
	writeJSON(w, http.StatusOK, reply)
}

// handleSetDeviceExtensionAutoUpdate turns git source updates on or off.
func (s *Server) handleSetDeviceExtensionAutoUpdate(w http.ResponseWriter, r *http.Request) {
	deviceID, ok := s.ownOnlineDevice(w, r)
	if !ok {
		return
	}
	id := strings.TrimSpace(r.PathValue("extensionId"))
	if !extensionIDPath.MatchString(id) {
		writeError(w, http.StatusBadRequest, "not an extension id")
		return
	}
	var input extensionAutoUpdateInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	reply, err := s.askDeviceExtension(r.Context(), deviceID, store.ExtensionRequestPayload{
		Action: "set-auto-update", ExtensionID: id, AutoUpdate: input.AutoUpdate,
	})
	if err != nil {
		writeDeviceConnectorError(w, "Updating extension settings", err)
		return
	}
	writeJSON(w, http.StatusOK, reply)
}

func (s *Server) visibilityChanged(ctx context.Context, deviceID string) {
	if err := s.store.DeleteConnectorVisibilityChecks(context.WithoutCancel(ctx), deviceID, ""); err != nil {
		s.connectors.ServerHeld.Logf("clear connector visibility for %s: %v", deviceID, err)
	}
	devices, err := s.store.ListDevices(context.WithoutCancel(ctx))
	if err != nil {
		return
	}
	owned := []store.DeviceProjection{}
	for _, device := range devices {
		if device.ID == deviceID {
			owned = append(owned, device)
			break
		}
	}
	if len(owned) > 0 {
		_ = s.refreshConnectorVisibility(context.WithoutCancel(ctx), owned, true)
	}
}
