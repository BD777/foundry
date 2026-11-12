package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var connectorPackageMCPTools = map[string]bool{"connector_packages": true}

type connectorPackageMCPSession struct {
	session store.AgentSession
	ownerID string
}

type connectorPackageMCPDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Online   bool   `json:"online"`
	Selected bool   `json:"selected"`
	// State is pending, installing, installed or failed (Error says why);
	// empty when the device has no part in the package.
	State    string `json:"state,omitempty"`
	Error    string `json:"error,omitempty"`
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason,omitempty"`
	// ReasonCode is no_instance when a server-held connector has no Ready
	// instance usable on this device; Instances are the ones that are.
	ReasonCode string                              `json:"reasonCode,omitempty"`
	Instances  []store.ConnectorPackageInstanceRef `json:"instances,omitempty"`
}

type connectorPackageMCPSummary struct {
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	Repository string `json:"repository"`
	Enabled    bool   `json:"enabled"`
	// EnabledDevices are the devices where the package is installed; Applying
	// says a selection is still being applied in the background (see each
	// device's state).
	EnabledDevices   []string                    `json:"enabledDevices"`
	Applying         bool                        `json:"applying"`
	ExtensionVersion string                      `json:"extensionVersion,omitempty"`
	ToolVersion      string                      `json:"toolVersion,omitempty"`
	Devices          []connectorPackageMCPDevice `json:"devices"`
	// Instances are a server-held connector's Ready instances and the
	// devices (ids) whose sessions can use each.
	Instances []store.ConnectorPackageInstance `json:"instances,omitempty"`
}

type connectorPackageMCPList struct {
	Packages []connectorPackageMCPSummary `json:"packages"`
}

func (s *Server) connectorPackageSessionForMCP(ctx context.Context, actor Actor) (connectorPackageMCPSession, error) {
	if !actor.Agent() {
		return connectorPackageMCPSession{}, &statusError{http.StatusForbidden, errors.New("connector_packages is available only to a person's agent session")}
	}
	session, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
	if err != nil || session.CreatedByUserID == "" {
		return connectorPackageMCPSession{}, &statusError{http.StatusForbidden, errors.New("connector_packages needs a session started by a person")}
	}
	if !connectorInstanceSessionAllowed(session) {
		return connectorPackageMCPSession{}, &statusError{http.StatusForbidden, errors.New("connector_packages is not available to Issue, verifier or utility sessions")}
	}
	return connectorPackageMCPSession{session: session, ownerID: session.CreatedByUserID}, nil
}

func (s *Server) connectorPackagePermission(ctx context.Context, caller connectorPackageMCPSession) (permission.Access, error) {
	return permission.Resolve(ctx, s.store, caller.session)
}

func connectorPackageDeviceAllowed(access permission.Access, kind, deviceID string) bool {
	if !access.Applicable {
		return true
	}
	return access.AllowsConnectorWrite(externalaccounts.DeviceAccountID(deviceID, kind))
}

func (s *Server) requireConnectorPackageDeviceWrites(
	ctx context.Context,
	caller connectorPackageMCPSession,
	kind string,
	current []string,
	next []string,
) error {
	access, err := s.connectorPackagePermission(ctx, caller)
	if err != nil {
		return err
	}
	if !access.Applicable {
		return nil
	}
	currentSet := map[string]bool{}
	for _, id := range current {
		currentSet[id] = true
	}
	nextSet := map[string]bool{}
	for _, id := range next {
		nextSet[id] = true
	}
	checked := map[string]bool{}
	for _, ids := range [][]string{current, next} {
		for _, id := range ids {
			if checked[id] || currentSet[id] == nextSet[id] {
				continue
			}
			checked[id] = true
			if !connectorPackageDeviceAllowed(access, kind, id) {
				return &statusError{http.StatusForbidden, fmt.Errorf("the person's assistant permission package does not allow changing the %s connector on device %s", kind, id)}
			}
		}
	}
	return nil
}

func connectorPackageDesiredDeviceIDs(current []string, args map[string]json.RawMessage) ([]string, error) {
	_, replace := args["deviceIds"]
	_, add := args["addDevices"]
	_, remove := args["removeDevices"]
	if !replace && !add && !remove {
		return nil, &statusError{http.StatusBadRequest, errors.New("deviceIds, addDevices or removeDevices is required")}
	}

	var wanted []string
	if replace {
		wanted = mcpArgList(args, "deviceIds")
	} else {
		wanted = append(wanted, current...)
	}
	removed := map[string]bool{}
	for _, id := range mcpArgList(args, "removeDevices") {
		removed[id] = true
	}
	kept := wanted[:0]
	for _, id := range wanted {
		if !removed[id] {
			kept = append(kept, id)
		}
	}
	wanted = kept
	for _, id := range mcpArgList(args, "addDevices") {
		wanted = append(wanted, id)
	}
	return connectorPackageDeviceIDs(wanted), nil
}

func (s *Server) connectorPackageMCPSummary(
	ctx context.Context,
	ownerUserID string,
	descriptor store.ConnectorDescriptor,
	devices []store.DeviceProjection,
	access permission.Access,
) (connectorPackageMCPSummary, error) {
	view, err := s.connectorPackageView(ctx, ownerUserID, descriptor, devices)
	if err != nil {
		return connectorPackageMCPSummary{}, err
	}
	summary := connectorPackageMCPSummary{
		Kind:           descriptor.Kind,
		Label:          descriptor.Label,
		Enabled:        view.Enabled,
		EnabledDevices: []string{},
		Devices:        make([]connectorPackageMCPDevice, 0, len(view.Devices)),
		Instances:      view.Instances,
	}
	if descriptor.Package != nil {
		summary.Repository = descriptor.Package.Upstream.Repository
	}
	if descriptor.Extension != nil {
		summary.ExtensionVersion = descriptor.Extension.Version
	}
	if view.Enabled {
		if repository, repositoryErr := s.store.GetSkillRepository(ctx, view.RepositoryID); repositoryErr == nil {
			summary.ToolVersion = repository.Version
			if summary.ToolVersion == "" {
				summary.ToolVersion = repository.Commit
			}
		}
	}
	for _, device := range view.Devices {
		eligible, reason := device.Eligible, device.Reason
		if eligible && !connectorPackageDeviceAllowed(access, descriptor.Kind, device.DeviceID) {
			eligible = false
			reason = "The person's assistant permission package does not allow this connector on this device."
		}
		summary.Devices = append(summary.Devices, connectorPackageMCPDevice{
			DeviceID:   device.DeviceID,
			Name:       device.Name,
			Online:     device.Online,
			Selected:   device.Selected,
			State:      string(device.State),
			Error:      device.Error,
			Eligible:   eligible,
			Reason:     reason,
			ReasonCode: string(device.ReasonCode),
			Instances:  device.Instances,
		})
		switch device.State {
		case store.ConnectorPackageDeviceStateInstalled:
			summary.EnabledDevices = append(summary.EnabledDevices, device.DeviceID)
		case store.ConnectorPackageDeviceStatePending, store.ConnectorPackageDeviceStateInstalling:
			summary.Applying = true
		}
	}
	return summary, nil
}

func (s *Server) auditConnectorPackageMCP(actor Actor, action, kind string, devices []string, cause error) {
	if !actor.Agent() {
		return
	}
	level := "info"
	result := "ok"
	if cause != nil {
		level, result = "error", "failed"
	}
	detail := fmt.Sprintf("connector_packages action=%s kind=%s result=%s", action, kind, result)
	if len(devices) > 0 {
		detail += " devices=" + strings.Join(connectorPackageDeviceIDs(devices), ",")
	}
	event := store.AgentSessionEvent{
		ID: "mcp_connector_package_" + uuid.NewString(), SessionID: actor.Identity.SessionID,
		Label: "Connector package action", Detail: detail, Level: level,
	}
	if err := s.store.AppendAgentSessionEvent(context.Background(), event); err != nil {
		log.Printf("connector package MCP audit for %s: %v", actor.Identity.SessionID, err)
	}
}

func (s *Server) connectorPackagesForMCP(call mcpCall) (text string, resultErr error) {
	action := strings.ToLower(mcpArgString(call.args, "action"))
	kind := strings.ToLower(mcpArgString(call.args, "kind"))
	devices := append(mcpArgList(call.args, "deviceIds"), mcpArgList(call.args, "addDevices")...)
	devices = append(devices, mcpArgList(call.args, "removeDevices")...)
	defer func() {
		s.auditConnectorPackageMCP(call.actor, action, kind, devices, resultErr)
	}()

	caller, err := s.connectorPackageSessionForMCP(call.r.Context(), call.actor)
	if err != nil {
		return "", err
	}
	access, err := s.connectorPackagePermission(call.r.Context(), caller)
	if err != nil {
		return "", err
	}

	switch action {
	case "list":
		descriptors, ownedDevices, err := s.packageDescriptors(call.r.Context(), caller.ownerID)
		if err != nil {
			return "", err
		}
		result := connectorPackageMCPList{Packages: make([]connectorPackageMCPSummary, 0, len(descriptors))}
		for _, descriptor := range descriptors {
			summary, err := s.connectorPackageMCPSummary(call.r.Context(), caller.ownerID, descriptor, ownedDevices, access)
			if err != nil {
				return "", err
			}
			result.Packages = append(result.Packages, summary)
		}
		text, err := encodeJSON(result)
		return text, err
	case "get":
		if kind == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("kind is required for get")}
		}
		descriptor, ownedDevices, err := s.packageDescriptorForOwner(call.r.Context(), caller.ownerID, kind)
		if errors.Is(err, store.ErrNotFound) {
			return "", &statusError{http.StatusNotFound, errors.New("connector package not found")}
		}
		if err != nil {
			return "", err
		}
		summary, err := s.connectorPackageMCPSummary(call.r.Context(), caller.ownerID, descriptor, ownedDevices, access)
		if err != nil {
			return "", err
		}
		text, err := encodeJSON(summary)
		return text, err
	case "set_devices":
		if kind == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("kind is required for set_devices")}
		}
		descriptor, ownedDevices, err := s.packageDescriptorForOwner(call.r.Context(), caller.ownerID, kind)
		if errors.Is(err, store.ErrNotFound) {
			return "", &statusError{http.StatusNotFound, errors.New("connector package not found")}
		}
		if err != nil {
			return "", err
		}
		current, currentErr := s.store.GetConnectorPackage(call.r.Context(), caller.ownerID, kind)
		if currentErr != nil && !errors.Is(currentErr, store.ErrNotFound) {
			return "", currentErr
		}
		wanted, err := connectorPackageDesiredDeviceIDs(current.Selected, call.args)
		if err != nil {
			return "", err
		}
		if err := s.requireConnectorPackageDeviceWrites(call.r.Context(), caller, kind, current.Devices, wanted); err != nil {
			return "", err
		}
		_, err = s.setConnectorPackageDeviceSelection(call.r.Context(), caller.ownerID, descriptor, ownedDevices, wanted)
		if err != nil {
			return "", err
		}
		summary, err := s.connectorPackageMCPSummary(call.r.Context(), caller.ownerID, descriptor, ownedDevices, access)
		if err != nil {
			return "", err
		}
		text, err := encodeJSON(summary)
		return text, err
	case "disable":
		if kind == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("kind is required for disable")}
		}
		current, err := s.store.GetConnectorPackage(call.r.Context(), caller.ownerID, kind)
		if errors.Is(err, store.ErrNotFound) {
			text, encodeErr := encodeJSON(map[string]any{"kind": kind, "disabled": true})
			return text, encodeErr
		}
		if err != nil {
			return "", err
		}
		if err := s.requireConnectorPackageDeviceWrites(call.r.Context(), caller, kind, current.Devices, nil); err != nil {
			return "", err
		}
		descriptor, _, descriptorErr := s.packageDescriptorForOwner(call.r.Context(), caller.ownerID, kind)
		if errors.Is(descriptorErr, store.ErrNotFound) {
			descriptor = store.ConnectorDescriptor{Kind: current.Kind, Label: current.Kind}
		} else if descriptorErr != nil {
			return "", descriptorErr
		}
		removed, err := s.removeConnectorPackage(call.r.Context(), caller.ownerID, descriptor)
		if err != nil {
			return "", err
		}
		text, err := encodeJSON(map[string]any{"kind": kind, "disabled": true, "devices": removed})
		return text, err
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be list, get, set_devices or disable")}
	}
}
