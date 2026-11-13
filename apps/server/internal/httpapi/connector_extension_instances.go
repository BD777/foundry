package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var serverHeldExtensionKind = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

const extensionProbeReportTimeout = 15 * time.Second

func (s *Server) serverHeldExtensionDescriptor(w http.ResponseWriter, r *http.Request, actorAccountID string) (store.ConnectorDescriptor, bool) {
	kind := strings.TrimSpace(r.PathValue("kind"))
	if !serverHeldExtensionKind.MatchString(kind) {
		writeError(w, http.StatusNotFound, "connector extension not found")
		return store.ConnectorDescriptor{}, false
	}
	descriptor, err := s.connectors.Devices.ServerHeldDescriptorForOwner(r.Context(), actorAccountID, kind)
	if err != nil {
		writeError(w, http.StatusNotFound, "connector extension not found")
		return store.ConnectorDescriptor{}, false
	}
	return descriptor, true
}

func (s *Server) handleListServerHeldExtensionInstances(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	instances, err := s.connectors.ServerHeld.ListExtensionInstances(r.Context(), actor.AccountID(), descriptor.Kind)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	devices, err := s.extensionInstanceDevices(r.Context(), actor.AccountID())
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, store.ConnectorServerHeldInstancesView{
		Kind: descriptor.Kind, Descriptor: descriptor, Instances: instances, Devices: devices,
	})
}

func (s *Server) handleProbeServerHeldExtensionInstance(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	var input store.ConnectorServerHeldInstanceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.prepareExtensionProbeDeviceRequest(w, r, actor.AccountID(), descriptor, input) {
		return
	}
	result, err := s.connectors.ServerHeld.ProbeExtensionInstance(r.Context(), actor.AccountID(), descriptor, input, nil)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleCreateServerHeldExtensionInstance(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	var input store.ConnectorServerHeldInstanceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.prepareExtensionProbeDeviceRequest(w, r, actor.AccountID(), descriptor, input) {
		return
	}
	instance, err := s.connectors.ServerHeld.CreateExtensionInstance(r.Context(), actor.AccountID(), descriptor, input)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, instance)
}

func (s *Server) handleReplaceServerHeldExtensionInstance(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	var input store.ConnectorServerHeldInstanceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.prepareExtensionProbeDeviceRequest(w, r, actor.AccountID(), descriptor, input) {
		return
	}
	instance, err := s.connectors.ServerHeld.ReplaceExtensionInstance(
		r.Context(), actor.AccountID(), descriptor.Kind, strings.TrimSpace(r.PathValue("instanceId")), descriptor, input,
	)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, instance)
}

func (s *Server) handleCheckServerHeldExtensionInstance(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	instance, err := s.connectors.ServerHeld.CheckExtensionInstance(
		r.Context(), actor.AccountID(), descriptor.Kind, strings.TrimSpace(r.PathValue("instanceId")), &descriptor,
	)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, instance)
}

func (s *Server) handleRevokeServerHeldExtensionInstance(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	descriptor, ok := s.serverHeldExtensionDescriptor(w, r, actor.AccountID())
	if !ok {
		return
	}
	instance, err := s.connectors.ServerHeld.RevokeExtensionInstance(
		r.Context(), actor.AccountID(), descriptor.Kind, strings.TrimSpace(r.PathValue("instanceId")), actor.AccountID(),
	)
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, instance)
}

func (s *Server) handleServerHeldExtensionSessionHandle(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	kind := strings.TrimSpace(r.PathValue("kind"))
	var input struct {
		SessionID string `json:"sessionId"`
		AccountID string `json:"accountId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	account, err := s.connectors.Extensions.CheckSession(
		r.Context(), kind, input.SessionID, actor.DeviceID, actor.AccountID(), input.AccountID,
	)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), input.SessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	handle, err := s.connectors.Extensions.IssueHandles(r.Context(), externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID,
		UserID: actor.AccountID(), Account: account,
	})
	if err != nil {
		writeServerHeldExtensionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, handle)
}

func (s *Server) handleServerHeldExtensionGateway(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	kind := strings.TrimSpace(r.PathValue("kind"))
	if !serverHeldExtensionKind.MatchString(kind) {
		writeError(w, http.StatusNotFound, "connector extension not found")
		return
	}
	s.connectors.Extensions.Serve(w, r, gateway.Device{ID: actor.DeviceID, OwnerUserID: actor.AccountID()}, kind)
}

func writeServerHeldExtensionError(w http.ResponseWriter, err error) {
	var probeErr *externalaccounts.ExtensionProbeError
	switch {
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		writeError(w, http.StatusPreconditionFailed, err.Error())
	case errors.Is(err, integrations.ErrOff):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.As(err, &probeErr):
		switch probeErr.Class {
		case "edge_access_required":
			writeJSON(w, http.StatusBadRequest, map[string]any{"code": "edge_access_required", "error": probeErr.Error(), "edgeAccess": probeErr.EdgeAccess})
		case "unauthorized", "forbidden", "url_invalid", "ssrf_blocked", "redirect_refused", "not_found", "bad_response":
			code := "extension_" + probeErr.Class
			if probeErr.Class == "ssrf_blocked" {
				code = "extension_private_network"
			}
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "error": probeErr.Error()})
		default:
			writeError(w, http.StatusBadGateway, probeErr.Error())
		}
	case errors.Is(err, externalaccounts.ErrInvalidExtensionInstance):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrExternalAppNotFound), errors.Is(err, store.ErrExternalAccountNotFound), errors.Is(err, connectors.ErrUnknownConnector):
		writeError(w, http.StatusNotFound, "connector extension instance not found")
	default:
		writeError(w, http.StatusBadGateway, "connector extension request failed; check the instance URL and fields")
	}
}

func (s *Server) extensionInstanceDevices(ctx context.Context, userID string) ([]store.ConnectorServerHeldDevice, error) {
	owned, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return nil, err
	}
	ownedSet := map[string]bool{}
	for _, id := range owned {
		ownedSet[id] = true
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]store.ConnectorServerHeldDevice, 0, len(owned))
	for _, device := range devices {
		if !ownedSet[device.ID] {
			continue
		}
		name := strings.TrimSpace(device.Label)
		if name == "" {
			name = device.ID
		}
		result = append(result, store.ConnectorServerHeldDevice{
			DeviceID: device.ID, Name: name, Online: s.hub.connectionFor(device.ID) != nil,
		})
	}
	return result, nil
}

func (s *Server) prepareExtensionProbeDeviceRequest(w http.ResponseWriter, r *http.Request, userID string, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) bool {
	err := s.prepareExtensionProbeDevice(r.Context(), userID, descriptor, input)
	if err == nil {
		return true
	}
	var invalid *statusError
	if errors.As(err, &invalid) {
		writeError(w, invalid.status, invalid.err.Error())
		return false
	}
	writeServerHeldExtensionError(w, err)
	return false
}

// prepareExtensionProbeDevice makes an explicitly selected owner device ready
// for a device-network probe. The person or their agent chose this device, so
// an extension already published to the package can be installed there before
// the probe; adding members' devices and enabling packages elsewhere keep the
// existing checks.
func (s *Server) prepareExtensionProbeDevice(ctx context.Context, userID string, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) error {
	if err := s.validateExtensionProbeDevice(ctx, userID, descriptor, input); err != nil {
		return err
	}
	if input.Network != externalaccounts.ExtensionNetworkDevice {
		return nil
	}
	if _, err := s.connectors.Devices.ServerHeldDescriptorOn(ctx, input.DeviceID, descriptor.Kind); err == nil {
		return nil
	}
	request, err := connectorExtensionInstallRequest(descriptor)
	if err != nil {
		return &statusError{http.StatusBadRequest, err}
	}
	if _, err := s.askDeviceExtension(ctx, input.DeviceID, request); err != nil {
		return &statusError{http.StatusBadGateway, fmt.Errorf("install %s on the selected device: %w", descriptor.Label, err)}
	}
	deadline := time.NewTimer(extensionProbeReportTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := s.connectors.Devices.ServerHeldDescriptorOn(ctx, input.DeviceID, descriptor.Kind); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return &statusError{
				http.StatusBadGateway,
				fmt.Errorf("%s was installed on the selected device, but the device has not reported it yet; try again in a moment", descriptor.Label),
			}
		case <-ticker.C:
		}
	}
}

func connectorExtensionInstallRequest(descriptor store.ConnectorDescriptor) (store.ExtensionRequestPayload, error) {
	if descriptor.Extension == nil {
		return store.ExtensionRequestPayload{}, errors.New("the selected device does not have this connector extension and no install source is available")
	}
	if descriptor.Extension.Source != nil {
		source := *descriptor.Extension.Source
		return store.ExtensionRequestPayload{Action: "install", Source: &source}, nil
	}
	if descriptor.Extension.Bundled != nil && *descriptor.Extension.Bundled {
		return store.ExtensionRequestPayload{Action: "install", BundledExtensionID: descriptor.Extension.ID}, nil
	}
	return store.ExtensionRequestPayload{}, errors.New("the selected device does not have this connector extension and it was installed from a local folder; install it on the selected device and try again")
}

func (s *Server) validateExtensionProbeDevice(ctx context.Context, userID string, descriptor store.ConnectorDescriptor, input store.ConnectorServerHeldInstanceInput) error {
	if input.Network != externalaccounts.ExtensionNetworkDevice {
		return nil
	}
	owned, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return err
	}
	ownedSet := map[string]bool{}
	for _, id := range owned {
		ownedSet[id] = true
	}
	if !ownedSet[input.DeviceID] {
		return &statusError{http.StatusBadRequest, errors.New("choose one of your own devices to validate this instance")}
	}
	if s.hub.connectionFor(input.DeviceID) == nil {
		return &statusError{http.StatusBadRequest, errors.New("the selected device is offline; bring it online and try again")}
	}
	return nil
}

func (s *Server) extensionDeviceRequest(ctx context.Context, deviceID string, request externalaccounts.ExtensionDeviceHTTPRequest) (externalaccounts.ExtensionDeviceHTTPResponse, error) {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return externalaccounts.ExtensionDeviceHTTPResponse{}, &externalaccounts.ExtensionProbeError{
			Class: "unreachable", Message: "the selected device is offline",
		}
	}
	timeout := time.Duration(request.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	reply, err := sendConnectorRequest(ctx, connection, store.ConnectorRequestPayload{
		Action: "extension_request",
		Connector: store.ConnectorDescriptor{
			Kind: "extension_network", Label: "Extension network request",
			Holding: store.ConnectorServerHeld, Adapter: "extension:network",
			Tool: store.ConnectorTool{Command: "extension-network"},
		},
		Extension: &store.ConnectorExtensionHTTPRequest{
			Method: request.Method, URL: request.URL, Headers: request.Headers,
			Body: base64.StdEncoding.EncodeToString(request.Body), TimeoutSeconds: request.TimeoutSeconds,
		},
	}, timeout)
	if err != nil {
		return externalaccounts.ExtensionDeviceHTTPResponse{}, err
	}
	if reply.Extension == nil {
		return externalaccounts.ExtensionDeviceHTTPResponse{}, &externalaccounts.ExtensionProbeError{
			Class: "bad_response", Message: "the device answered without an upstream response",
		}
	}
	if reply.Extension.Error != "" {
		return externalaccounts.ExtensionDeviceHTTPResponse{}, &externalaccounts.ExtensionProbeError{
			Class: "unreachable", Message: reply.Extension.Error,
		}
	}
	headers := http.Header{}
	for name, values := range reply.Extension.Headers {
		for _, value := range values {
			headers.Add(name, value)
		}
	}
	body, err := base64.StdEncoding.DecodeString(reply.Extension.Body)
	if err != nil {
		return externalaccounts.ExtensionDeviceHTTPResponse{}, &externalaccounts.ExtensionProbeError{
			Class: "bad_response", Message: "the device returned an unreadable upstream response",
		}
	}
	return externalaccounts.ExtensionDeviceHTTPResponse{
		Status: reply.Extension.Status, Headers: headers, Body: body,
	}, nil
}

func sendConnectorRequest(ctx context.Context, connection *daemonConnection, payload store.ConnectorRequestPayload, timeout time.Duration) (store.ConnectorReplyPayload, error) {
	request, err := json.Marshal(payload)
	if err != nil {
		return store.ConnectorReplyPayload{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	reply, err := daemonRequest[store.ConnectorReplyPayload](requestCtx, connection, wsConnectorRequestType, request)
	if err == nil && reply.Error != "" {
		err = errors.New(reply.Error)
	}
	return reply, err
}

func (s *Server) extensionDevices(ctx context.Context, ownerUserID, kind string) ([]externalaccounts.ExtensionDeviceCandidate, error) {
	owned, err := s.store.DevicesOwnedBy(ctx, ownerUserID)
	if err != nil {
		return nil, err
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, device := range devices {
		names[device.ID] = strings.TrimSpace(device.Label)
	}
	candidates := make([]externalaccounts.ExtensionDeviceCandidate, 0, len(owned))
	for _, deviceID := range owned {
		name := names[deviceID]
		if name == "" {
			name = deviceID
		}
		_, installedErr := s.connectors.Devices.ServerHeldDescriptorOn(ctx, deviceID, kind)
		candidates = append(candidates, externalaccounts.ExtensionDeviceCandidate{
			ID: deviceID, Name: name, Online: s.hub.connectionFor(deviceID) != nil, Installed: installedErr == nil,
		})
	}
	return candidates, nil
}

// probeExtensionsOnDevice probes the owner's device-network instances from a
// device that just came online and has not been probed for them yet.
func (s *Server) probeExtensionsOnDevice(ctx context.Context, deviceID string) {
	owner, err := s.store.DeviceOwner(ctx, deviceID)
	if err != nil || owner == "" {
		return
	}
	if err := s.connectors.ServerHeld.ProbeExtensionOnNewDevice(ctx, owner, deviceID); err != nil {
		log.Printf("probe connector instances on device %s: %v", deviceID, err)
	}
}
