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

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Device-held connectors (docs/connectors.md): the credential stays on the
// device; the server relays the person's actions to the device's worker
// (connector_request) and keeps what the worker read back, never a token.
// The rules a request must pass:
//
//   - only a device's owner reads, installs, signs in or signs out a
//     connector on it (ownDevice; an Admin of an ownerless device does not);
//   - a workspace's bindings are read by viewers and set by maintainers, and
//     a person binds only their own devices; others see a binding's device
//     and whether members may use it, never its login;
//   - a session uses a device's login only under connectors.DeviceEligible
//     (connectors.go in internal/connectors, decided at dispatch).

const (
	connectorStatusTimeout  = 45 * time.Second
	connectorSignInTimeout  = 60 * time.Second
	connectorInstallTimeout = 10 * time.Minute
	// connectorStaleAfter: the page re-reads an online device whose reading
	// is older than this.
	connectorStaleAfter = 2 * time.Minute
)

var (
	errConnectorDeviceOffline = errors.New("The device is offline; try again once it reconnects.")
	errConnectorWorkerTooOld  = errors.New("This device's worker is too old for device-held connectors; update its worker first.")
)

// askDeviceConnector sends one action to the device's worker and returns
// its answer; an error the worker reports comes back as an error.
func (s *Server) askDeviceConnector(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, action string, fresh bool, timeout time.Duration) (store.ConnectorReplyPayload, error) {
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return store.ConnectorReplyPayload{}, errConnectorDeviceOffline
	}
	if !connection.hasCapability(store.DaemonCapabilityDeviceConnectors) {
		return store.ConnectorReplyPayload{}, errConnectorWorkerTooOld
	}
	request, err := json.Marshal(store.ConnectorRequestPayload{Action: action, Connector: descriptor, Fresh: fresh})
	if err != nil {
		return store.ConnectorReplyPayload{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	reply, err := daemonRequest[store.ConnectorReplyPayload](ctx, connection, wsConnectorRequestType, request)
	if err == nil && reply.Error != "" {
		err = errors.New(reply.Error)
	}
	return reply, err
}

// readDeviceConnector reads the connector on the device and keeps it.
func (s *Server) readDeviceConnector(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, fresh bool) (store.DeviceConnectorState, error) {
	reply, err := s.askDeviceConnector(ctx, deviceID, descriptor, "status", fresh, connectorStatusTimeout)
	if err != nil {
		return store.DeviceConnectorState{}, err
	}
	if reply.State == nil {
		return store.DeviceConnectorState{}, errors.New("the device answered without a status")
	}
	reading := *reply.State
	reading.Kind = descriptor.Kind
	return s.connectors.Devices.Record(ctx, deviceID, reading)
}

// ownDevices is the person's devices as listed, in the store's order.
func (s *Server) ownDevices(ctx context.Context, userID string) ([]store.DeviceProjection, error) {
	owned, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return nil, err
	}
	mine := map[string]bool{}
	for _, id := range owned {
		mine[id] = true
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	var listed []store.DeviceProjection
	for _, device := range devices {
		if mine[device.ID] {
			listed = append(listed, device)
		}
	}
	return listed, nil
}

// deviceConnectorDevices pairs the devices with what they last read; with
// refresh, online devices whose reading is stale are read first, together.
func (s *Server) deviceConnectorDevices(ctx context.Context, devices []store.DeviceProjection, refresh bool) ([]store.DeviceConnectorDevice, error) {
	ids := make([]string, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
	}
	if refresh {
		states, err := s.connectors.Devices.States(ctx, ids)
		if err != nil {
			return nil, err
		}
		s.refreshStaleConnectors(ctx, ids, states)
	}
	states, err := s.connectors.Devices.States(ctx, ids)
	if err != nil {
		return nil, err
	}
	byDevice := map[string][]store.DeviceConnectorState{}
	for _, state := range states {
		byDevice[state.DeviceID] = append(byDevice[state.DeviceID], state)
	}
	listed := make([]store.DeviceConnectorDevice, 0, len(devices))
	for _, device := range devices {
		connection := s.hub.connectionFor(device.ID)
		entry := store.DeviceConnectorDevice{
			DeviceID: device.ID, Name: device.Label, Online: connection != nil,
			Supported: connection != nil && connection.hasCapability(store.DaemonCapabilityDeviceConnectors),
			States:    byDevice[device.ID],
		}
		if entry.States == nil {
			entry.States = []store.DeviceConnectorState{}
		}
		listed = append(listed, entry)
	}
	return listed, nil
}

func (s *Server) refreshStaleConnectors(ctx context.Context, deviceIDs []string, states []store.DeviceConnectorState) {
	checked := map[string]time.Time{}
	for _, state := range states {
		if at, err := time.Parse(time.RFC3339, state.CheckedAt); err == nil {
			checked[state.DeviceID+"\x00"+state.Kind] = at
		}
	}
	ctx, cancel := context.WithTimeout(ctx, connectorStatusTimeout)
	defer cancel()
	var wg sync.WaitGroup
	for _, deviceID := range deviceIDs {
		connection := s.hub.connectionFor(deviceID)
		if connection == nil || !connection.hasCapability(store.DaemonCapabilityDeviceConnectors) {
			continue
		}
		for _, descriptor := range s.connectors.Devices.Connectors() {
			if at, ok := checked[deviceID+"\x00"+descriptor.Kind]; ok && time.Since(at) < connectorStaleAfter {
				continue
			}
			wg.Add(1)
			go func(deviceID string, descriptor store.ConnectorDescriptor) {
				defer wg.Done()
				if _, err := s.readDeviceConnector(ctx, deviceID, descriptor, false); err != nil {
					s.connectors.ServerHeld.Logf("read %s on device %s: %v", descriptor.Kind, deviceID, err)
				}
			}(deviceID, descriptor)
		}
	}
	wg.Wait()
}

// handleDeviceConnectorsView is the device-held part of the Connectors
// page: the person's devices with each device-held connector on them.
// ?refresh=1 reads online devices whose reading is stale first.
func (s *Server) handleDeviceConnectorsView(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	devices, err := s.ownDevices(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	listed, err := s.deviceConnectorDevices(r.Context(), devices, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, store.DeviceConnectorsView{Connectors: s.connectors.Devices.Connectors(), Devices: listed})
}

// ownDeviceConnector checks the caller owns the path's device and the path
// names a device-held connector; it writes the refusal otherwise.
func (s *Server) ownDeviceConnector(w http.ResponseWriter, r *http.Request) (string, store.ConnectorDescriptor, bool) {
	if _, ok := personActor(w, r); !ok {
		return "", store.ConnectorDescriptor{}, false
	}
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return "", store.ConnectorDescriptor{}, false
	}
	if !scope.ownsDevice(deviceID) {
		writeError(w, http.StatusNotFound, "device not found")
		return "", store.ConnectorDescriptor{}, false
	}
	descriptor, err := s.connectors.Devices.Connector(strings.TrimSpace(r.PathValue("kind")))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return "", store.ConnectorDescriptor{}, false
	}
	return deviceID, descriptor, true
}

func writeDeviceConnectorError(w http.ResponseWriter, action string, err error) {
	switch {
	case errors.Is(err, errConnectorDeviceOffline), errors.Is(err, errConnectorWorkerTooOld):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusBadGateway, fmt.Sprintf("%s on the device failed: %v", action, err))
	}
}

// handleCheckDeviceConnector reads the connector on the device now.
func (s *Server) handleCheckDeviceConnector(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	state, err := s.readDeviceConnector(r.Context(), deviceID, descriptor, true)
	if err != nil {
		writeDeviceConnectorError(w, "Checking "+descriptor.Label, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// handleInstallDeviceConnector installs or upgrades the connector's tool
// through Foundry's managed tools, at the owner's click only.
func (s *Server) handleInstallDeviceConnector(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	reply, err := s.askDeviceConnector(r.Context(), deviceID, descriptor, "install", true, connectorInstallTimeout)
	if err != nil {
		writeDeviceConnectorError(w, "Installing "+descriptor.Label, err)
		return
	}
	state, err := s.recordReply(r.Context(), deviceID, descriptor, reply)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) recordReply(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, reply store.ConnectorReplyPayload) (store.DeviceConnectorState, error) {
	if reply.State == nil {
		return s.readDeviceConnector(ctx, deviceID, descriptor, true)
	}
	reading := *reply.State
	reading.Kind = descriptor.Kind
	return s.connectors.Devices.Record(ctx, deviceID, reading)
}

// handleBeginDeviceConnectorSignIn starts the tool's own sign-in on the
// device. The answer is the page the person approves on; the challenge
// itself stays on the device.
func (s *Server) handleBeginDeviceConnectorSignIn(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	reply, err := s.askDeviceConnector(r.Context(), deviceID, descriptor, "sign_in_begin", true, connectorSignInTimeout)
	if err == nil && reply.SignIn == nil {
		err = errors.New("the device answered without a sign-in")
	}
	if err != nil {
		writeDeviceConnectorError(w, "Signing in to "+descriptor.Label, err)
		return
	}
	writeJSON(w, http.StatusAccepted, s.signInAnswer(r.Context(), deviceID, descriptor, reply))
}

// handlePollDeviceConnectorSignIn asks the device once whether the person
// approved; a poll right after another gets that one's answer.
func (s *Server) handlePollDeviceConnectorSignIn(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	if answer, ok := s.connectors.Devices.RecentSignInPoll(deviceID, descriptor.Kind); ok {
		writeJSON(w, http.StatusOK, answer)
		return
	}
	reply, err := s.askDeviceConnector(r.Context(), deviceID, descriptor, "sign_in_poll", true, connectorSignInTimeout)
	if err == nil && reply.SignIn == nil {
		err = errors.New("the device answered without a sign-in")
	}
	if err != nil {
		writeDeviceConnectorError(w, "Signing in to "+descriptor.Label, err)
		return
	}
	answer := s.signInAnswer(r.Context(), deviceID, descriptor, reply)
	s.connectors.Devices.RememberSignInPoll(deviceID, descriptor.Kind, answer)
	writeJSON(w, http.StatusOK, answer)
}

// signInAnswer is the sign-in as the person sees it; a completed one
// carries the connector's state as the device now reads it, which is kept.
func (s *Server) signInAnswer(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, reply store.ConnectorReplyPayload) store.DeviceConnectorSignIn {
	answer := *reply.SignIn
	answer.State = nil
	if answer.Status == "complete" {
		state, err := s.recordReply(ctx, deviceID, descriptor, reply)
		if err != nil {
			s.connectors.ServerHeld.Logf("read %s on device %s after sign-in: %v", descriptor.Kind, deviceID, err)
		} else {
			answer.State = &state
		}
	}
	return answer
}

// handleSignOutDeviceConnector signs the device's tool out, on the owner's
// explicit request.
func (s *Server) handleSignOutDeviceConnector(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	reply, err := s.askDeviceConnector(r.Context(), deviceID, descriptor, "sign_out", true, connectorSignInTimeout)
	if err != nil {
		writeDeviceConnectorError(w, "Signing out of "+descriptor.Label, err)
		return
	}
	state, err := s.recordReply(r.Context(), deviceID, descriptor, reply)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// handleWorkspaceDeviceConnectors is a workspace's device-held bindings,
// with the caller's own devices to bind.
func (s *Server) handleWorkspaceDeviceConnectors(w http.ResponseWriter, r *http.Request) {
	view, err := s.workspaceDeviceConnectors(r.Context(), strings.TrimSpace(r.PathValue("id")), actorFromContext(r.Context()).AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) workspaceDeviceConnectors(ctx context.Context, workspaceID, viewerID string) (store.WorkspaceDeviceConnectors, error) {
	view := store.WorkspaceDeviceConnectors{WorkspaceID: workspaceID, Connectors: s.connectors.Devices.Connectors(), Bindings: []store.DeviceConnectorBinding{}, Devices: []store.DeviceConnectorDevice{}}
	bindings, err := s.connectors.Devices.Bindings(ctx, workspaceID)
	if err != nil {
		return view, err
	}
	all, err := s.store.ListDevices(ctx)
	if err != nil {
		return view, err
	}
	names := map[string]string{}
	for _, device := range all {
		names[device.ID] = device.Label
	}
	var own []store.DeviceProjection
	if viewerID != "" {
		if own, err = s.ownDevices(ctx, viewerID); err != nil {
			return view, err
		}
		if view.Devices, err = s.deviceConnectorDevices(ctx, own, false); err != nil {
			return view, err
		}
	}
	ownStates := map[string]store.DeviceConnectorState{}
	for _, device := range view.Devices {
		for _, state := range device.States {
			ownStates[device.DeviceID+"\x00"+state.Kind] = state
		}
	}
	for _, binding := range bindings {
		binding.DeviceName = names[binding.DeviceID]
		if state, ok := ownStates[binding.DeviceID+"\x00"+binding.Kind]; ok && binding.GrantedBy == viewerID {
			binding.State = &state
		}
		view.Bindings = append(view.Bindings, binding)
	}
	return view, nil
}

// handleSetWorkspaceDeviceConnectors replaces the caller's bindings in the
// workspace (a maintainer, by the route; their own devices, by the service).
func (s *Server) handleSetWorkspaceDeviceConnectors(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.SetWorkspaceDeviceConnectorsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	if err := s.connectors.Devices.SetBindings(r.Context(), workspaceID, actor.AccountID(), input.Bindings, scope.ownsDevice); err != nil {
		switch {
		case errors.Is(err, connectors.ErrUnknownConnector):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, connectors.ErrNotDeviceOwner):
			writeError(w, http.StatusNotFound, "device not found")
		default:
			writeResult(w, nil, err)
		}
		return
	}
	view, err := s.workspaceDeviceConnectors(r.Context(), workspaceID, actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
