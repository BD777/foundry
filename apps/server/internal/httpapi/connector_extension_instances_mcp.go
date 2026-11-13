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

const (
	connectorInstanceSecretProxyHeader = "X-Foundry-MCP-Secret-Proxy"
	connectorInstanceSecretProxyValue  = "connector-instances-v1"
)

var connectorInstanceMCPTools = map[string]bool{"connector_instances": true}

type connectorInstanceSession struct {
	session store.AgentSession
	ownerID string
	device  string
}

func connectorInstanceSessionAllowed(session store.AgentSession) bool {
	return session.CreatedByUserID != "" &&
		session.IssueID == "" &&
		session.Source != store.SessionSourceVerification &&
		session.Source != store.SessionSourceIssue &&
		!store.IsUtilitySessionSource(session.Source) &&
		session.Role != store.AgentSessionRoleIssueExecution &&
		session.Role != store.AgentSessionRoleIssueClarification
}

type connectorInstanceSummary struct {
	ID               string                                 `json:"id"`
	AccountID        string                                 `json:"accountId"`
	Kind             string                                 `json:"kind"`
	Label            string                                 `json:"label"`
	BaseURL          string                                 `json:"baseUrl,omitempty"`
	Network          string                                 `json:"network"`
	Status           string                                 `json:"status"`
	StatusDetail     string                                 `json:"statusDetail,omitempty"`
	Access           string                                 `json:"access,omitempty"`
	Version          string                                 `json:"version,omitempty"`
	RouteCount       int                                    `json:"routeCount"`
	AvailableDevices []store.ConnectorServerHeldDeviceCheck `json:"availableDevices,omitempty"`
	UpdatedAt        string                                 `json:"updatedAt,omitempty"`
}

type connectorInstanceDescriptorSummary struct {
	Kind    string                           `json:"kind"`
	Label   string                           `json:"label"`
	Fields  []store.ConnectorField           `json:"fields"`
	Steps   []store.ConnectorServerHeldStep  `json:"steps"`
	Network store.ConnectorServerHeldNetwork `json:"network"`
}

type connectorInstanceListResult struct {
	Kind       string                             `json:"kind"`
	Descriptor connectorInstanceDescriptorSummary `json:"descriptor"`
	Instances  []connectorInstanceSummary         `json:"instances"`
}

func (s *Server) personToolSessionForMCP(ctx context.Context, actor Actor, tool string) (connectorInstanceSession, error) {
	if !actor.Agent() {
		return connectorInstanceSession{}, &statusError{http.StatusForbidden, errors.New(tool + " is available only to a person's agent session")}
	}
	session, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
	if err != nil || session.CreatedByUserID == "" {
		return connectorInstanceSession{}, &statusError{http.StatusForbidden, errors.New(tool + " needs a session started by a person")}
	}
	if !connectorInstanceSessionAllowed(session) {
		return connectorInstanceSession{}, &statusError{http.StatusForbidden, errors.New(tool + " is not available to Issue, verifier or utility sessions")}
	}
	deviceID := strings.TrimSpace(session.DeviceID)
	if deviceID == "" {
		workspace, workspaceErr := s.store.GetWorkspace(ctx, session.WorkspaceID)
		if workspaceErr != nil {
			return connectorInstanceSession{}, workspaceErr
		}
		deviceID = strings.TrimSpace(workspace.DeviceID)
	}
	devices, err := s.store.DevicesOwnedBy(ctx, session.CreatedByUserID)
	if err != nil {
		return connectorInstanceSession{}, err
	}
	owned := false
	for _, ownedDevice := range devices {
		owned = owned || ownedDevice == deviceID
	}
	if !owned {
		return connectorInstanceSession{}, &statusError{http.StatusForbidden, errors.New(tool + " reads files only on a device owned by the person who started the session")}
	}
	return connectorInstanceSession{session: session, ownerID: session.CreatedByUserID, device: deviceID}, nil
}

func (s *Server) connectorInstanceSessionForMCP(ctx context.Context, actor Actor) (connectorInstanceSession, error) {
	return s.personToolSessionForMCP(ctx, actor, "connector_instances")
}

func (s *Server) connectorInstancePermission(ctx context.Context, caller connectorInstanceSession) (permission.Access, error) {
	return permission.Resolve(ctx, s.store, caller.session)
}

func (s *Server) connectorInstanceAccount(ctx context.Context, caller connectorInstanceSession, kind, instanceID string) (store.ConnectorServerHeldInstance, error) {
	instances, err := s.connectors.ServerHeld.ListExtensionInstances(ctx, caller.ownerID, kind)
	if err != nil {
		return store.ConnectorServerHeldInstance{}, err
	}
	for _, instance := range instances {
		if instance.ID == instanceID {
			return instance, nil
		}
	}
	return store.ConnectorServerHeldInstance{}, store.ErrExternalAppNotFound
}

func (s *Server) requireConnectorInstanceWrite(ctx context.Context, caller connectorInstanceSession, accountID string) error {
	access, err := s.connectorInstancePermission(ctx, caller)
	if err != nil {
		return err
	}
	if access.Applicable && !access.AllowsConnectorWrite(accountID) {
		return &statusError{http.StatusForbidden, errors.New("the person's assistant permission package does not allow changing this connector account")}
	}
	return nil
}

func (s *Server) requireConnectorInstanceWorkspace(ctx context.Context, caller connectorInstanceSession, workspaceID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return &statusError{http.StatusBadRequest, errors.New("workspaceId is required")}
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, caller.ownerID)
	if err != nil {
		return err
	}
	if !roleAtLeast(roles[workspaceID], store.WorkspaceRoleMaintainer) {
		return &statusError{http.StatusForbidden, errors.New("binding a connector account needs Maintainer or Owner in that workspace")}
	}
	access, err := s.connectorInstancePermission(ctx, caller)
	if err != nil {
		return err
	}
	if access.Applicable && !access.WorkspaceAllowed(workspaceID) {
		return &statusError{http.StatusForbidden, errors.New("the person's assistant permission package does not allow this workspace")}
	}
	return nil
}

func connectorInstanceSummaryOf(instance store.ConnectorServerHeldInstance, descriptor store.ConnectorDescriptor) connectorInstanceSummary {
	baseURL := ""
	if descriptor.ServerHeld != nil && instance.Values != nil {
		baseURL = strings.TrimSpace(instance.Values[descriptor.ServerHeld.Upstream.BaseField])
	}
	devices := append([]store.ConnectorServerHeldDeviceCheck(nil), instance.AvailableDevices...)
	return connectorInstanceSummary{
		ID: instance.ID, AccountID: instance.AccountID, Kind: instance.Kind,
		Label: instance.Label, BaseURL: baseURL, Network: instance.Network,
		Status: instance.Status, StatusDetail: instance.StatusDetail,
		Access: string(instance.Access), Version: instance.Version,
		RouteCount: instance.RouteCount, AvailableDevices: devices,
		UpdatedAt: instance.UpdatedAt,
	}
}

func connectorInstanceInputFromMCP(args map[string]json.RawMessage, descriptor store.ConnectorDescriptor) (store.ConnectorServerHeldInstanceInput, map[string]string, error) {
	input := store.ConnectorServerHeldInstanceInput{
		Label:    mcpArgString(args, "label"),
		Network:  mcpArgString(args, "network"),
		DeviceID: mcpArgString(args, "probeDeviceId"),
		Fields:   map[string]string{},
	}
	if raw, ok := args["fields"]; ok {
		if err := json.Unmarshal(raw, &input.Fields); err != nil {
			return input, nil, &statusError{http.StatusBadRequest, errors.New("fields must map field ids to string values")}
		}
	}
	if input.Fields == nil {
		input.Fields = map[string]string{}
	}
	secretIDs := map[string]bool{}
	if descriptor.ServerHeld != nil {
		for _, field := range descriptor.ServerHeld.Fields {
			if field.Type == "secret" {
				secretIDs[field.ID] = true
			}
		}
	}
	for id, value := range input.Fields {
		if secretIDs[id] && strings.TrimSpace(value) != "" {
			return input, nil, &statusError{http.StatusBadRequest, errors.New("secret fields cannot be supplied in fields; use secretFiles so the session worker reads the value from a file")}
		}
	}
	secrets := map[string]string{}
	if raw, ok := args["secretFiles"]; ok {
		var unresolved map[string]json.RawMessage
		if err := json.Unmarshal(raw, &unresolved); err != nil || len(unresolved) > 0 {
			return input, nil, &statusError{http.StatusBadRequest, errors.New("secretFiles must be resolved by the session worker before this request reaches Foundry")}
		}
	}
	if raw, ok := args["secretValues"]; ok {
		if err := json.Unmarshal(raw, &secrets); err != nil {
			return input, nil, &statusError{http.StatusBadRequest, errors.New("secretValues must map secret field ids to strings")}
		}
	}
	for id, value := range secrets {
		if !secretIDs[id] {
			return input, nil, fmt.Errorf("unknown secret field %q", id)
		}
		value = strings.TrimSpace(value)
		if value != "" {
			input.Fields[id] = value
		}
	}
	return input, secrets, nil
}

func connectorInstanceSecretsForRedaction(secrets map[string]string) []string {
	values := make([]string, 0, len(secrets))
	for _, value := range secrets {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func redactConnectorInstanceError(err error, secrets map[string]string) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	var edgeErr *externalaccounts.ExtensionProbeError
	if errors.As(err, &edgeErr) && edgeErr.EdgeAccess != nil {
		message = "edge_access_required: " + message
	}
	if len(secrets) > 0 {
		for _, secret := range connectorInstanceSecretsForRedaction(secrets) {
			message = strings.ReplaceAll(message, secret, "[REDACTED]")
		}
	}
	var probeErr *externalaccounts.ExtensionProbeError
	if errors.As(err, &probeErr) && probeErr.Message != "" {
		for _, secret := range connectorInstanceSecretsForRedaction(secrets) {
			probeErr.Message = strings.ReplaceAll(probeErr.Message, secret, "[REDACTED]")
		}
	}
	return errors.New(message)
}

func redactConnectorInstanceText(text string, secrets map[string]string) string {
	for _, secret := range connectorInstanceSecretsForRedaction(secrets) {
		text = strings.ReplaceAll(text, secret, "[REDACTED]")
	}
	return text
}

func (s *Server) auditConnectorInstanceMCP(actor Actor, action, kind, instanceID string, cause error) {
	if !actor.Agent() {
		return
	}
	level := "info"
	result := "ok"
	if cause != nil {
		level, result = "error", "failed"
	}
	detail := fmt.Sprintf("connector_instances action=%s kind=%s result=%s", action, kind, result)
	if instanceID != "" {
		detail += " instance=" + instanceID
	}
	event := store.AgentSessionEvent{
		ID: "mcp_connector_" + uuid.NewString(), SessionID: actor.Identity.SessionID,
		Label: "Connector instance action", Detail: detail, Level: level,
	}
	if err := s.store.AppendAgentSessionEvent(context.Background(), event); err != nil {
		log.Printf("connector instance MCP audit for %s: %v", actor.Identity.SessionID, err)
	}
}

func (s *Server) connectorInstancesForMCP(call mcpCall) (text string, resultErr error) {
	action := strings.ToLower(mcpArgString(call.args, "action"))
	kind := strings.ToLower(mcpArgString(call.args, "kind"))
	instanceID := strings.TrimSpace(mcpArgString(call.args, "instanceId"))
	defer func() {
		s.auditConnectorInstanceMCP(call.actor, action, kind, instanceID, resultErr)
	}()

	caller, err := s.connectorInstanceSessionForMCP(call.r.Context(), call.actor)
	if err != nil {
		return "", err
	}
	if !serverHeldExtensionKind.MatchString(kind) {
		return "", &statusError{http.StatusBadRequest, errors.New("kind must name an installed server-held connector extension")}
	}
	descriptor, err := s.connectors.Devices.ServerHeldDescriptorForOwner(call.r.Context(), caller.ownerID, kind)
	if err != nil {
		return "", store.ErrExternalAppNotFound
	}
	if descriptor.ServerHeld == nil {
		return "", &statusError{http.StatusBadRequest, errors.New("that connector does not declare server-held instances")}
	}
	input, secrets, err := connectorInstanceInputFromMCP(call.args, descriptor)
	if err != nil {
		return "", err
	}
	if len(secrets) > 0 && call.r.Header.Get(connectorInstanceSecretProxyHeader) != connectorInstanceSecretProxyValue {
		return "", &statusError{http.StatusForbidden, errors.New("secretValues are accepted only from the session worker's secret proxy")}
	}

	switch action {
	case "list":
		access, err := s.connectorInstancePermission(call.r.Context(), caller)
		if err != nil {
			return "", err
		}
		instances, err := s.connectors.ServerHeld.ListExtensionInstances(call.r.Context(), caller.ownerID, kind)
		if err != nil {
			return "", err
		}
		summaries := make([]connectorInstanceSummary, 0, len(instances))
		for _, instance := range instances {
			if access.Applicable && !access.AllowsConnector(instance.AccountID) {
				continue
			}
			summaries = append(summaries, connectorInstanceSummaryOf(instance, descriptor))
		}
		value := connectorInstanceListResult{
			Kind: descriptor.Kind,
			Descriptor: connectorInstanceDescriptorSummary{
				Kind: descriptor.Kind, Label: descriptor.Label,
				Fields: descriptor.ServerHeld.Fields, Steps: descriptor.ServerHeld.Steps,
				Network: descriptor.ServerHeld.Network,
			},
			Instances: summaries,
		}
		text, err := encodeJSON(value)
		return text, redactConnectorInstanceError(err, secrets)
	case "probe":
		if err := s.prepareExtensionProbeDevice(call.r.Context(), caller.ownerID, descriptor, input); err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		probed, err := s.connectors.ServerHeld.ProbeExtensionInstance(call.r.Context(), caller.ownerID, descriptor, input, nil)
		if err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		text, err := encodeJSON(probed)
		return redactConnectorInstanceText(text, secrets), redactConnectorInstanceError(err, secrets)
	case "create":
		if err := s.prepareExtensionProbeDevice(call.r.Context(), caller.ownerID, descriptor, input); err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		instance, err := s.connectors.ServerHeld.CreateExtensionInstance(call.r.Context(), caller.ownerID, descriptor, input)
		if err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		text, err := encodeJSON(connectorInstanceSummaryOf(instance, descriptor))
		return text, redactConnectorInstanceError(err, secrets)
	}

	if instanceID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("instanceId is required for " + action)}
	}
	instance, err := s.connectorInstanceAccount(call.r.Context(), caller, kind, instanceID)
	if err != nil {
		return "", store.ErrExternalAppNotFound
	}
	if err := s.requireConnectorInstanceWrite(call.r.Context(), caller, instance.AccountID); err != nil {
		return "", err
	}

	switch action {
	case "update":
		if err := s.prepareExtensionProbeDevice(call.r.Context(), caller.ownerID, descriptor, input); err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		updated, err := s.connectors.ServerHeld.ReplaceExtensionInstance(
			call.r.Context(), caller.ownerID, kind, instanceID, descriptor, input,
		)
		if err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		text, err := encodeJSON(connectorInstanceSummaryOf(updated, descriptor))
		return text, redactConnectorInstanceError(err, secrets)
	case "check":
		checked, err := s.connectors.ServerHeld.CheckExtensionInstance(
			call.r.Context(), caller.ownerID, kind, instanceID, &descriptor,
		)
		if err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		text, err := encodeJSON(connectorInstanceSummaryOf(checked, descriptor))
		return text, redactConnectorInstanceError(err, secrets)
	case "revoke":
		revoked, err := s.connectors.ServerHeld.RevokeExtensionInstance(
			call.r.Context(), caller.ownerID, kind, instanceID, caller.ownerID,
		)
		if err != nil {
			return "", redactConnectorInstanceError(err, secrets)
		}
		text, err := encodeJSON(connectorInstanceSummaryOf(revoked, descriptor))
		return text, redactConnectorInstanceError(err, secrets)
	case "bind_workspace", "unbind_workspace":
		workspaceID := mcpArgString(call.args, "workspaceId")
		if err := s.requireConnectorInstanceWorkspace(call.r.Context(), caller, workspaceID); err != nil {
			return "", err
		}
		actor := WorkspaceActor{UserID: caller.ownerID, SessionID: caller.session.ID}
		if action == "bind_workspace" {
			_, err = s.ChangeWorkspaceConnectors(call.r.Context(), actor, workspaceID, []string{instance.AccountID}, nil)
		} else {
			_, err = s.ChangeWorkspaceConnectors(call.r.Context(), actor, workspaceID, nil, []string{instance.AccountID})
		}
		if err != nil {
			return "", err
		}
		text, err := encodeJSON(map[string]any{
			"status": strings.TrimSuffix(action, "_workspace"),
			"kind":   kind, "workspaceId": workspaceID, "instance": connectorInstanceSummaryOf(instance, descriptor),
		})
		return text, err
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be list, probe, create, update, check, revoke, bind_workspace or unbind_workspace")}
	}
}
