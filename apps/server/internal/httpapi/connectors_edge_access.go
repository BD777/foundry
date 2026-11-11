package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	edgeAccessZeroTrustRequiredCode    = "cloudflare_zero_trust_required"
	edgeAccessZeroTrustRequiredMessage = "到 连接器 › Cloudflare 重新授权，勾选 Zero Trust"
)

// Edge access credentials: gateway pre-authentication matched by address,
// independent of any connector. The person (or the MCP tool acting for them)
// manages them; secrets go in on create and replace and never come back.

type edgeAccessServiceWriter struct {
	service *externalaccounts.Service
	created store.EdgeAccess
}

var _ connectors.EdgeAccessWriter = (*edgeAccessServiceWriter)(nil)

func (w *edgeAccessServiceWriter) CreateEdgeAccess(ctx context.Context, owner string, input connectors.EdgeAccessCreateInput) (string, error) {
	item, err := w.service.CreateEdgeAccess(ctx, owner, store.EdgeAccessInput{
		Label:    input.Label,
		Provider: store.EdgeAccessProvider(input.Provider),
		Match: store.EdgeAccessMatch{
			Host:       input.Match.Host,
			PathPrefix: input.Match.PathPrefix,
		},
		Team:         input.Team,
		ClientID:     input.ClientID,
		ClientSecret: input.ClientSecret,
	})
	if err != nil {
		return "", err
	}
	w.created = item
	return item.ID, nil
}

func (s *Server) handleListEdgeAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	list, err := s.connectors.ServerHeld.ListEdgeAccess(r.Context(), actor.AccountID())
	if err != nil {
		writeEdgeAccessError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateEdgeAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.EdgeAccessInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	item, err := s.connectors.ServerHeld.CreateEdgeAccess(r.Context(), actor.AccountID(), input)
	if err != nil {
		writeEdgeAccessError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, item)
}

type edgeAccessProvisionResponse struct {
	EdgeAccess       store.EdgeAccess                        `json:"edgeAccess"`
	AccountID        string                                  `json:"accountId"`
	ServiceTokenName string                                  `json:"serviceTokenName"`
	ServiceTokenID   string                                  `json:"serviceTokenId"`
	ApplicationID    string                                  `json:"applicationId"`
	PolicyID         string                                  `json:"policyId"`
	NeedsIngress     bool                                    `json:"needsIngress"`
	SuggestedIngress *connectors.EdgeAccessIngressSuggestion `json:"suggestedIngress,omitempty"`
}

type edgeAccessProvisionInput struct {
	Provider string `json:"provider"`
	Team     string `json:"team"`
	Host     string `json:"host"`
	Path     string `json:"path"`
}

func (s *Server) provisionEdgeAccess(ctx context.Context, owner string, input edgeAccessProvisionInput) (edgeAccessProvisionResponse, error) {
	provisionStore, ok := any(s.store).(connectors.CloudflareAutoProvisionStore)
	if !ok {
		return edgeAccessProvisionResponse{}, errors.New("edge access provisioning store is unavailable")
	}
	writer := &edgeAccessServiceWriter{service: s.connectors.ServerHeld}
	provisioner := connectors.NewCloudflareAutoProvisioner(provisionStore, s.connectors.ServerHeld, writer)
	result, err := provisioner.Provision(ctx, connectors.CloudflareAutoProvisionInput{
		Owner:    owner,
		Provider: input.Provider,
		Team:     input.Team,
		Host:     input.Host,
		Path:     input.Path,
	})
	if err != nil {
		return edgeAccessProvisionResponse{}, err
	}
	return edgeAccessProvisionResponse{
		EdgeAccess:       writer.created,
		AccountID:        result.AccountID,
		ServiceTokenName: result.ServiceTokenName,
		ServiceTokenID:   result.ServiceTokenID,
		ApplicationID:    result.ApplicationID,
		PolicyID:         result.PolicyID,
		NeedsIngress:     result.Tunnel.NeedsIngress,
		SuggestedIngress: result.Tunnel.SuggestedIngress,
	}, nil
}

func (s *Server) handleProvisionEdgeAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input edgeAccessProvisionInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	response, err := s.provisionEdgeAccess(r.Context(), actor.AccountID(), input)
	if err != nil {
		writeEdgeAccessProvisionError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, response)
}

func (s *Server) handleReplaceEdgeAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input store.EdgeAccessInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	item, err := s.connectors.ServerHeld.ReplaceEdgeAccess(r.Context(), actor.AccountID(), strings.TrimSpace(r.PathValue("id")), input)
	if err != nil {
		writeEdgeAccessError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleDeleteEdgeAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	if err := s.connectors.ServerHeld.DeleteEdgeAccess(r.Context(), actor.AccountID(), strings.TrimSpace(r.PathValue("id"))); err != nil {
		writeEdgeAccessError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeEdgeAccessProvisionError(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, connectors.ErrCloudflareZeroTrustRequired):
		writeJSON(w, http.StatusForbidden, map[string]string{
			"code":  edgeAccessZeroTrustRequiredCode,
			"error": edgeAccessZeroTrustRequiredMessage,
		})
	case errors.Is(err, connectors.ErrCloudflareAutoProvisionInput), errors.Is(err, externalaccounts.ErrInvalidEdgeAccess):
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code":  "invalid_edge_access_requirement",
			"error": err.Error(),
		})
	case errors.Is(err, connectors.ErrCloudflareAccountNotConnected):
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":  "cloudflare_account_required",
			"error": err.Error(),
		})
	case errors.Is(err, connectors.ErrCloudflareAccountAmbiguous):
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":  "cloudflare_account_ambiguous",
			"error": err.Error(),
		})
	case errors.Is(err, store.ErrEdgeAccessConflict):
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":  "edge_access_conflict",
			"error": err.Error(),
		})
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"code":  "secret_store_unavailable",
			"error": err.Error(),
		})
	case errors.Is(err, externalaccounts.ErrEdgeAccessUnsupported):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code":  "edge_access_unavailable",
			"error": err.Error(),
		})
	default:
		log.Printf("edge access provisioning failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"code":  "cloudflare_provision_failed",
			"error": "Cloudflare automatic provisioning failed",
		})
	}
}

func writeEdgeAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, externalaccounts.ErrSecretsNotConfigured):
		writeError(w, http.StatusPreconditionFailed, err.Error())
	case errors.Is(err, externalaccounts.ErrInvalidEdgeAccess):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "edge access credential not found")
	case errors.Is(err, store.ErrEdgeAccessConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, externalaccounts.ErrEdgeAccessUnsupported):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	default:
		log.Printf("edge access request failed: %v", err)
		writeError(w, http.StatusInternalServerError, "edge access request failed")
	}
}
