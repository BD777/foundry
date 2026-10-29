package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
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
	connectorStatusTimeout  = 150 * time.Second
	connectorSignInTimeout  = 150 * time.Second
	connectorInstallTimeout = 10 * time.Minute
	// connectorStaleAfter: the page re-reads an online device whose reading
	// is older than this.
	connectorStaleAfter = 2 * time.Minute
)

var (
	errConnectorDeviceOffline = errors.New("The device is offline; try again once it reconnects.")
	errConnectorBusy          = errors.New("connector_busy")
	errConnectorWorkerTooOld  = errors.New("This device's worker is too old for device-held connectors; update its worker first.")
)

type connectorCommandError struct{ message string }

func (e *connectorCommandError) Error() string { return e.message }

// askDeviceConnector sends one action to the device's worker and returns
// its answer; an error the worker reports comes back as an error.
func (s *Server) askDeviceConnector(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, action string, fresh bool, timeout time.Duration, authorization ...store.ConnectorRequestPayload) (store.ConnectorReplyPayload, error) {
	if err := store.RequireDeviceAvailable(ctx, s.store, deviceID); err != nil {
		return store.ConnectorReplyPayload{}, err
	}
	connection := s.hub.connectionFor(deviceID)
	if connection == nil {
		return store.ConnectorReplyPayload{}, errConnectorDeviceOffline
	}
	if !connection.hasCapability(store.DaemonCapabilityDeviceConnectors) {
		return store.ConnectorReplyPayload{}, errConnectorWorkerTooOld
	}
	payload := store.ConnectorRequestPayload{Action: action, Connector: descriptor, Fresh: fresh}
	if len(authorization) > 0 {
		if !connection.hasCapability(store.DaemonCapabilityConnectorAuthorization) {
			return store.ConnectorReplyPayload{}, errConnectorWorkerTooOld
		}
		payload.AuthorizationID = authorization[0].AuthorizationID
		payload.AuthorizationRevision = authorization[0].AuthorizationRevision
		payload.OperationID = authorization[0].OperationID
	}
	request, err := json.Marshal(payload)
	if err != nil {
		return store.ConnectorReplyPayload{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now()
	reply, err := daemonRequest[store.ConnectorReplyPayload](ctx, connection, wsConnectorRequestType, request)
	s.connectors.ServerHeld.Logf("connector RPC device=%s kind=%s action=%s operation=%s elapsed_ms=%d received=%t", deviceID, descriptor.Kind, action, payload.OperationID, time.Since(started).Milliseconds(), err == nil)
	if err == nil && reply.Error != "" {
		if reply.Error == "connector_busy" {
			err = errConnectorBusy
		} else {
			err = &connectorCommandError{message: reply.Error}
		}
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
	devices, err := store.DeviceCandidates(ctx, s.store)
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
			AuthorizationSupported: connection != nil && connection.hasCapability(store.DaemonCapabilityConnectorAuthorization),
			InstallerSupported:     connection != nil && connection.hasCapability(store.DaemonCapabilityConnectorInstaller),
			Supported:              connection != nil && connection.hasCapability(store.DaemonCapabilityDeviceConnectors),
			States:                 byDevice[device.ID],
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
	if err := store.RequireDeviceAvailable(r.Context(), s.store, deviceID); err != nil {
		writeResult(w, nil, err)
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
	s.deviceConnectorAuthorization(w, r, deviceID, descriptor, true)
}

func (s *Server) handlePollDeviceConnectorSignIn(w http.ResponseWriter, r *http.Request) {
	deviceID, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	s.deviceConnectorAuthorization(w, r, deviceID, descriptor, false)
}

func (s *Server) deviceConnectorAuthorization(w http.ResponseWriter, r *http.Request, deviceID string, descriptor store.ConnectorDescriptor, begin bool) {
	var input connectorAuthorizationInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if len(input.RequestID) > 100 || len(input.OperationID) > 100 || (begin && input.RequestID == "") {
		writeError(w, http.StatusBadRequest, "authorization request ID is required")
		return
	}
	scope, err := authorizationScope(descriptor, input)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if input.AuthorizationID != "" {
		c := s.hub.connectionFor(deviceID)
		if c != nil && !c.hasCapability(store.DaemonCapabilityConnectorAuthorization) {
			writeDeviceConnectorError(w, "Authorizing", errConnectorWorkerTooOld)
			return
		}
	}
	owner := actorFromContext(r.Context()).AccountID()
	background := context.WithoutCancel(r.Context())
	answer, err := s.connectors.Devices.Authorize(owner, deviceID, scope, input.RequestID, input.OperationID, begin, func(operationID, phase string, progress func(string)) (store.DeviceConnectorSignIn, error) {
		ctx, cancel := context.WithTimeout(background, 4*time.Minute)
		defer cancel()
		currentOwner, err := s.store.DeviceOwner(ctx, deviceID)
		if err != nil {
			return store.DeviceConnectorSignIn{}, err
		}
		if currentOwner != owner {
			return store.DeviceConnectorSignIn{Status: "failed", Error: "Device ownership changed; this authorization is no longer permitted."}, nil
		}
		mark := func(next string) {
			progress(next)
			s.connectors.ServerHeld.Logf("connector authorization device=%s kind=%s group=%s operation=%s phase=%s", deviceID, descriptor.Kind, input.AuthorizationID, operationID, next)
		}
		verify := func() (store.DeviceConnectorSignIn, error) {
			state, err := s.readDeviceConnector(ctx, deviceID, descriptor, true)
			if err != nil {
				return store.DeviceConnectorSignIn{}, err
			}
			if authorizationReady(state, input) {
				return store.DeviceConnectorSignIn{Status: "complete", State: &state}, nil
			}
			return store.DeviceConnectorSignIn{Status: "failed", Error: "The device did not confirm a usable login for this capability. Check its status before starting another authorization."}, nil
		}
		if phase == "verifying" {
			mark("verifying")
			return verify()
		}
		action := "sign_in_poll"
		if phase == "checking" {
			mark("checking")
			state, err := s.readDeviceConnector(ctx, deviceID, descriptor, true)
			if err != nil {
				return store.DeviceConnectorSignIn{}, err
			}
			if authorizationReady(state, input) && (input.AuthorizationID != "" || state.Status == store.DeviceConnectorReady) {
				return store.DeviceConnectorSignIn{Status: "complete", State: &state}, nil
			}
			if state.Status == store.DeviceConnectorNotInstalled || state.Status == store.DeviceConnectorUnavailable {
				return store.DeviceConnectorSignIn{Status: "failed", Error: fmt.Sprintf("connector is %s: %s", state.Status, state.StatusDetail)}, nil
			}
			if state.Status == store.DeviceConnectorError {
				return store.DeviceConnectorSignIn{}, errors.New("local login status could not be checked")
			}
			action = "sign_in_begin"
			mark("starting")
		}
		var options []store.ConnectorRequestPayload
		if c := s.hub.connectionFor(deviceID); c != nil && c.hasCapability(store.DaemonCapabilityConnectorAuthorization) {
			options = append(options, store.ConnectorRequestPayload{AuthorizationID: input.AuthorizationID, AuthorizationRevision: input.AuthorizationRevision, OperationID: operationID})
		} else if input.AuthorizationID != "" {
			return store.DeviceConnectorSignIn{}, errConnectorDeviceOffline
		}
		reply, err := s.askDeviceConnector(ctx, deviceID, descriptor, action, true, connectorSignInTimeout, options...)
		if err != nil {
			if errors.Is(err, errConnectorBusy) && action == "sign_in_begin" {
				mark("checking")
			}
			var native *connectorCommandError
			if errors.As(err, &native) {
				return store.DeviceConnectorSignIn{Status: "failed", Error: native.message}, nil
			}
			return store.DeviceConnectorSignIn{}, err
		}
		if reply.SignIn == nil {
			return store.DeviceConnectorSignIn{}, errors.New("device returned no authorization receipt")
		}
		answer := *reply.SignIn
		answer.State = nil
		if answer.Status == "complete" {
			mark("verifying")
			return verify()
		}
		if answer.Status == "pending" {
			answer.Phase = "awaiting_user"
			mark("awaiting_user")
		}
		if answer.Status == "pending" && reply.AuthorizationImage != "" {
			image, err := base64.StdEncoding.DecodeString(reply.AuthorizationImage)
			if err != nil || len(image) > 512*1024 || !bytes.HasPrefix(image, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
				return store.DeviceConnectorSignIn{Status: "failed", Error: "Invalid authorization image."}, nil
			}
			answer.Image = image
			answer.Challenge = &store.ConnectorAuthorizationChallenge{Kind: "qr_image"}
		}
		return answer, nil
	})
	if err != nil {
		if errors.Is(err, connectors.ErrAuthorizationOperation) {
			writeError(w, http.StatusConflict, err.Error())
		} else {
			writeDeviceConnectorError(w, "Signing in to "+descriptor.Label, err)
		}
		return
	}
	answer.AuthorizationID = input.AuthorizationID
	answer.AuthorizationRevision = input.AuthorizationRevision
	if answer.Challenge != nil && answer.Challenge.Kind == "qr_image" {
		challenge := *answer.Challenge
		challenge.ImageURL = fmt.Sprintf("/api/devices/%s/connectors/%s/sign-in/image?operationId=%s&authorizationId=%s&authorizationRevision=%d", url.PathEscape(deviceID), url.PathEscape(descriptor.Kind), url.QueryEscape(answer.OperationID), url.QueryEscape(input.AuthorizationID), input.AuthorizationRevision)
		answer.Challenge = &challenge
	}
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusOK
	if begin {
		status = http.StatusAccepted
	}
	writeJSON(w, status, answer)
}

// signInAnswer is the sign-in as the person sees it; a completed one
// carries the connector's state as the device now reads it, which is kept.
func (s *Server) signInAnswer(ctx context.Context, deviceID string, descriptor store.ConnectorDescriptor, reply store.ConnectorReplyPayload, authorization ...connectorAuthorizationInput) store.DeviceConnectorSignIn {
	answer := *reply.SignIn
	answer.State = nil
	if answer.Status == "complete" {
		state, err := s.readDeviceConnector(ctx, deviceID, descriptor, true)
		if err != nil {
			answer.Status, answer.Error = "failed", "Signed in, but the device login could not be checked. Check again before using it."
			s.connectors.ServerHeld.Logf("read %s on device %s after sign-in: %v", descriptor.Kind, deviceID, err)
		} else if !authorizationReady(state, firstAuthorizationInput(authorization)) {
			answer.Status, answer.Error = "failed", "The device did not confirm a usable login. Check again."
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
	var reply store.ConnectorReplyPayload
	err := s.connectors.Devices.InvalidateAuthorization(deviceID, descriptor.Kind, func() error {
		var err error
		reply, err = s.askDeviceConnector(r.Context(), deviceID, descriptor, "sign_out", true, connectorSignInTimeout)
		return err
	})
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
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return view, err
	}
	view.DefaultDeviceID = workspace.DeviceID
	targets, err := s.connectorExecutionDevices(ctx, workspaceID)
	if err != nil {
		return view, err
	}
	view.ExecutionDevices = targets
	allowed := map[string]bool{}
	for _, target := range targets {
		allowed[target.DeviceID] = true
	}
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
		scoped := own[:0]
		for _, device := range own {
			if allowed[device.ID] {
				scoped = append(scoped, device)
			}
		}
		if view.Devices, err = s.deviceConnectorDevices(ctx, scoped, true); err != nil {
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
	targets, err := s.connectorExecutionDevices(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	allowed := map[string]bool{}
	for _, target := range targets {
		allowed[target.DeviceID] = true
	}
	existing, err := s.connectors.Devices.Bindings(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, binding := range input.Bindings {
		if !scope.ownsDevice(binding.DeviceID) {
			writeError(w, http.StatusNotFound, "device not found")
			return
		}
		if allowed[binding.DeviceID] {
			continue
		}
		unchanged := false
		for _, old := range existing {
			if old.GrantedBy == actor.AccountID() && old.Kind == binding.Kind && old.DeviceID == binding.DeviceID && old.Members == binding.Members {
				unchanged = true
			}
		}
		if !unchanged {
			writeError(w, http.StatusConflict, "this device does not execute sessions in this workspace")
			return
		}
	}
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

// Match sessionDevice: the workspace device is the default; explicit agents
// registered for this workspace can be selected on their own execution device.
func (s *Server) connectorExecutionDevices(ctx context.Context, workspaceID string) ([]store.ConnectorExecutionDevice, error) {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	agents, err := s.store.ListAgents(ctx, workspaceID, "")
	if err != nil {
		return nil, err
	}
	devices, err := store.DeviceCandidates(ctx, s.store)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, d := range devices {
		names[d.ID] = d.Label
	}
	seen := map[string]bool{}
	result := []store.ConnectorExecutionDevice{}
	add := func(id string) {
		if id != "" && names[id] != "" && !seen[id] {
			seen[id] = true
			name := names[id]
			if name == "" {
				name = id
			}
			result = append(result, store.ConnectorExecutionDevice{DeviceID: id, Name: name})
		}
	}
	add(workspace.DeviceID)
	for _, agent := range agents {
		add(agent.DeviceID)
	}
	return result, nil
}

type connectorAuthorizationInput struct {
	RequestID             string `json:"requestId"`
	OperationID           string `json:"operationId"`
	AuthorizationID       string `json:"authorizationId"`
	AuthorizationRevision int    `json:"authorizationRevision"`
}

func firstAuthorizationInput(values []connectorAuthorizationInput) connectorAuthorizationInput {
	if len(values) > 0 {
		return values[0]
	}
	return connectorAuthorizationInput{}
}
func authorizationScope(descriptor store.ConnectorDescriptor, input connectorAuthorizationInput) (string, error) {
	if input.AuthorizationID == "" {
		return descriptor.Kind, nil
	}
	for _, g := range descriptor.AuthorizationGroups {
		if g.ID == input.AuthorizationID && g.Revision == input.AuthorizationRevision {
			return descriptor.Kind + "\x00" + g.ID + "\x00" + strconv.Itoa(g.Revision), nil
		}
	}
	return "", errors.New("unsupported authorization capability or revision")
}
func authorizationReady(state store.DeviceConnectorState, input connectorAuthorizationInput) bool {
	if input.AuthorizationID == "" {
		return state.SignedIn && (state.Status == store.DeviceConnectorReady || state.Status == store.DeviceConnectorExpiring)
	}
	for _, a := range state.Authorizations {
		if a.ID == input.AuthorizationID && a.Revision == input.AuthorizationRevision {
			return a.Status == "ready"
		}
	}
	return false
}
func (s *Server) handleDeviceConnectorAuthorizationImage(w http.ResponseWriter, r *http.Request) {
	device, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	revision, _ := strconv.Atoi(r.URL.Query().Get("authorizationRevision"))
	input := connectorAuthorizationInput{OperationID: r.URL.Query().Get("operationId"), AuthorizationID: r.URL.Query().Get("authorizationId"), AuthorizationRevision: revision}
	scope, err := authorizationScope(descriptor, input)
	if err != nil {
		writeError(w, http.StatusNotFound, "authorization not found")
		return
	}
	data, err := s.connectors.Devices.AuthorizationImage(actorFromContext(r.Context()).AccountID(), device, scope, input.OperationID)
	if err != nil {
		writeError(w, http.StatusNotFound, "authorization image no longer available")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
func (s *Server) handleDismissDeviceConnectorAuthorization(w http.ResponseWriter, r *http.Request) {
	device, descriptor, ok := s.ownDeviceConnector(w, r)
	if !ok {
		return
	}
	var input connectorAuthorizationInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	scope, err := authorizationScope(descriptor, input)
	if err == nil {
		err = s.connectors.Devices.Dismiss(actorFromContext(r.Context()).AccountID(), device, scope, input.OperationID)
	}
	if err != nil {
		writeError(w, http.StatusConflict, "authorization is no longer active")
		return
	}
	if input.AuthorizationID != "" {
		_, _ = s.askDeviceConnector(r.Context(), device, descriptor, "sign_in_dismiss", false, 5*time.Second, store.ConnectorRequestPayload{AuthorizationID: input.AuthorizationID, AuthorizationRevision: input.AuthorizationRevision, OperationID: input.OperationID})
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
