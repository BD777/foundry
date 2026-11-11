package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

const edgeAccessSecretProxyHeader = connectorInstanceSecretProxyHeader

var edgeAccessMCPTools = map[string]bool{"edge_access": true}

type edgeAccessInputResult struct {
	input   store.EdgeAccessInput
	secrets map[string]string
}

func edgeAccessInputFromMCP(args map[string]json.RawMessage) (edgeAccessInputResult, error) {
	input := store.EdgeAccessInput{
		Label:    mcpArgString(args, "label"),
		Provider: store.EdgeAccessProvider(mcpArgString(args, "provider")),
		Team:     mcpArgString(args, "team"),
		Audience: mcpArgString(args, "audience"),
	}
	if raw, ok := args["match"]; ok {
		if err := json.Unmarshal(raw, &input.Match); err != nil {
			return edgeAccessInputResult{}, &statusError{http.StatusBadRequest, errors.New("match must contain host and optional pathPrefix strings")}
		}
	}
	if raw, ok := args["secretFiles"]; ok {
		var unresolved map[string]json.RawMessage
		if err := json.Unmarshal(raw, &unresolved); err != nil || len(unresolved) > 0 {
			return edgeAccessInputResult{}, &statusError{http.StatusBadRequest, errors.New("secretFiles must be resolved by the session worker before this request reaches Foundry")}
		}
	}
	secrets := map[string]string{}
	if raw, ok := args["secretValues"]; ok {
		if err := json.Unmarshal(raw, &secrets); err != nil {
			return edgeAccessInputResult{}, &statusError{http.StatusBadRequest, errors.New("secretValues must map clientId and clientSecret to strings")}
		}
	}
	for field, value := range secrets {
		if field != "clientId" && field != "clientSecret" {
			return edgeAccessInputResult{}, &statusError{http.StatusBadRequest, errors.New("edge_access secretValues accepts only clientId and clientSecret")}
		}
		value = strings.TrimSpace(value)
		if value == "" {
			delete(secrets, field)
			continue
		}
		if field == "clientId" {
			input.ClientID = value
		} else {
			input.ClientSecret = value
		}
		secrets[field] = value
	}
	return edgeAccessInputResult{input: input, secrets: secrets}, nil
}

func edgeAccessProvisionInputFromMCP(args map[string]json.RawMessage) (edgeAccessProvisionInput, error) {
	raw, ok := args["edgeAccessRequired"]
	if !ok {
		return edgeAccessProvisionInput{}, &statusError{http.StatusBadRequest, errors.New("edgeAccessRequired is required for provision")}
	}
	var required store.EdgeAccessRequired
	if err := json.Unmarshal(raw, &required); err != nil {
		return edgeAccessProvisionInput{}, &statusError{http.StatusBadRequest, errors.New("edgeAccessRequired must be an edge access requirement")}
	}
	return edgeAccessProvisionInput{
		Provider: string(required.Provider),
		Team:     required.Team,
		Host:     required.Host,
		Path:     required.Path,
	}, nil
}

func edgeAccessStatusError(err error) error {
	if err == nil {
		return nil
	}
	var status *statusError
	if errors.As(err, &status) {
		return err
	}
	switch {
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		return &statusError{http.StatusPreconditionFailed, err}
	case errors.Is(err, externalaccounts.ErrInvalidEdgeAccess):
		return &statusError{http.StatusBadRequest, err}
	case errors.Is(err, store.ErrNotFound):
		return &statusError{http.StatusNotFound, errors.New("edge access credential not found")}
	case errors.Is(err, store.ErrEdgeAccessConflict):
		return &statusError{http.StatusConflict, err}
	case errors.Is(err, externalaccounts.ErrEdgeAccessUnsupported):
		return &statusError{http.StatusServiceUnavailable, err}
	default:
		return err
	}
}

func edgeAccessProvisionStatusError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, connectors.ErrCloudflareZeroTrustRequired):
		return &statusError{http.StatusForbidden, errors.New(edgeAccessZeroTrustRequiredMessage)}
	case errors.Is(err, connectors.ErrCloudflareAutoProvisionInput), errors.Is(err, externalaccounts.ErrInvalidEdgeAccess):
		return &statusError{http.StatusBadRequest, err}
	case errors.Is(err, connectors.ErrCloudflareAccountNotConnected), errors.Is(err, connectors.ErrCloudflareAccountAmbiguous), errors.Is(err, store.ErrEdgeAccessConflict):
		return &statusError{http.StatusConflict, err}
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		return &statusError{http.StatusPreconditionFailed, err}
	case errors.Is(err, externalaccounts.ErrEdgeAccessUnsupported):
		return &statusError{http.StatusServiceUnavailable, err}
	default:
		return &statusError{http.StatusBadGateway, errors.New("Cloudflare automatic provisioning failed")}
	}
}

func (s *Server) auditEdgeAccessMCP(actor Actor, action, id string, cause error) {
	if !actor.Agent() {
		return
	}
	level, result := "info", "ok"
	if cause != nil {
		level, result = "error", "failed"
	}
	detail := fmt.Sprintf("edge_access action=%s result=%s", action, result)
	if id != "" {
		detail += " id=" + id
	}
	event := store.AgentSessionEvent{
		ID: "mcp_edge_access_" + uuid.NewString(), SessionID: actor.Identity.SessionID,
		Label: "Edge access action", Detail: detail, Level: level,
	}
	if err := s.store.AppendAgentSessionEvent(context.Background(), event); err != nil {
		log.Printf("edge access MCP audit for %s: %v", actor.Identity.SessionID, err)
	}
}

func (s *Server) edgeAccessForMCP(call mcpCall) (text string, resultErr error) {
	action := strings.ToLower(strings.TrimSpace(mcpArgString(call.args, "action")))
	id := strings.TrimSpace(mcpArgString(call.args, "id"))
	defer func() {
		s.auditEdgeAccessMCP(call.actor, action, id, resultErr)
	}()

	caller, err := s.personToolSessionForMCP(call.r.Context(), call.actor, "edge_access")
	if err != nil {
		return "", err
	}
	parsed, err := edgeAccessInputFromMCP(call.args)
	if err != nil {
		return "", err
	}
	if len(parsed.secrets) > 0 && call.r.Header.Get(edgeAccessSecretProxyHeader) != connectorInstanceSecretProxyValue {
		return "", &statusError{http.StatusForbidden, errors.New("secretValues are accepted only from the session worker's secret proxy")}
	}
	redact := func(err error) error {
		if err == nil {
			return nil
		}
		message := redactConnectorInstanceText(err.Error(), parsed.secrets)
		var status *statusError
		if errors.As(err, &status) {
			return &statusError{status.status, errors.New(message)}
		}
		return errors.New(message)
	}

	switch action {
	case "list":
		list, err := s.connectors.ServerHeld.ListEdgeAccess(call.r.Context(), caller.ownerID)
		if err != nil {
			return "", redact(edgeAccessStatusError(err))
		}
		text, err := encodeJSON(list)
		return redactConnectorInstanceText(text, parsed.secrets), redact(err)
	case "create":
		if parsed.input.ClientID == "" || parsed.input.ClientSecret == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("create needs secretFiles.clientId and secretFiles.clientSecret")}
		}
		item, err := s.connectors.ServerHeld.CreateEdgeAccess(call.r.Context(), caller.ownerID, parsed.input)
		if err != nil {
			return "", redact(edgeAccessStatusError(err))
		}
		text, err := encodeJSON(item)
		return redactConnectorInstanceText(text, parsed.secrets), redact(err)
	case "replace":
		if id == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("id is required for replace")}
		}
		item, err := s.connectors.ServerHeld.ReplaceEdgeAccess(call.r.Context(), caller.ownerID, id, parsed.input)
		if err != nil {
			return "", redact(edgeAccessStatusError(err))
		}
		text, err := encodeJSON(item)
		return redactConnectorInstanceText(text, parsed.secrets), redact(err)
	case "delete":
		if id == "" {
			return "", &statusError{http.StatusBadRequest, errors.New("id is required for delete")}
		}
		if err := s.connectors.ServerHeld.DeleteEdgeAccess(call.r.Context(), caller.ownerID, id); err != nil {
			return "", redact(edgeAccessStatusError(err))
		}
		text, err := encodeJSON(map[string]any{"status": "deleted", "id": id})
		return text, err
	case "provision":
		input, err := edgeAccessProvisionInputFromMCP(call.args)
		if err != nil {
			return "", err
		}
		provisioned, err := s.provisionEdgeAccess(call.r.Context(), caller.ownerID, input)
		if err != nil {
			return "", edgeAccessProvisionStatusError(err)
		}
		text, err := encodeJSON(provisioned)
		return redactConnectorInstanceText(text, parsed.secrets), redact(err)
	default:
		return "", &statusError{http.StatusBadRequest, errors.New("action must be list, create, replace, delete or provision")}
	}
}
