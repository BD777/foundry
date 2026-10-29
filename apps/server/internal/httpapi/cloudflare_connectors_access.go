package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// cloudflareBindingAccess is the access level of the workspace's binding
// of accountID: read unless its owner chose another.
func (s *Server) cloudflareBindingAccess(ctx context.Context, workspaceID, accountID string) string {
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return externalaccounts.CloudflareAccessRead
	}
	for _, binding := range bindings {
		if binding.AccountID == accountID && binding.Access != "" {
			return binding.Access
		}
	}
	return externalaccounts.CloudflareAccessRead
}

// handleSetCloudflareAccess sets the access level of the caller's
// Cloudflare binding in a workspace (DEV-092). Only the account's owner
// sets it, and only to a level the account's grant holds the scopes of.
func (s *Server) handleSetCloudflareAccess(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	var input struct {
		Access string `json:"access"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	workspaceID := strings.TrimSpace(r.PathValue("id"))
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("accountId")))
	if !ok {
		return
	}
	if account.Provider != "cloudflare" {
		writeError(w, http.StatusNotFound, "Cloudflare account not found")
		return
	}
	level, known := externalaccounts.CloudflareAccessLevel(input.Access)
	if !known {
		writeError(w, http.StatusBadRequest, "unknown Cloudflare access level")
		return
	}
	if missing := externalaccounts.MissingScopes(level, account.GrantedScopes); len(missing) > 0 {
		writeError(w, http.StatusConflict, "this Cloudflare authorization does not include "+strings.Join(missing, ", ")+"; re-authorize the account with that permission first")
		return
	}
	before := s.cloudflareBindingAccess(r.Context(), workspaceID, account.ID)
	if err := s.store.SetExternalAccountBindingAccess(r.Context(), workspaceID, account.ID, actor.AccountID(), level.Name); err != nil {
		if errors.Is(err, store.ErrExternalAccountNotFound) {
			writeError(w, http.StatusNotFound, "bind zones of this Cloudflare account to the workspace first")
			return
		}
		writeResult(w, nil, err)
		return
	}
	if before != level.Name {
		detail, _ := json.Marshal(map[string]string{"workspaceId": workspaceID, "from": before, "to": level.Name})
		if err := s.store.AppendExternalAccountEvent(r.Context(), store.ExternalAccountEvent{AccountID: account.ID, Kind: "access_changed", ActorID: actor.AccountID(), Detail: string(detail)}); err != nil {
			s.connectors.ServerHeld.Logf("cloudflare access audit in %s: %v", workspaceID, err)
		}
	}
	view, err := s.workspaceExternalAccounts(r.Context(), workspaceID, actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handleCloudflareActivity lists the account's recent changes made through
// Foundry and its access-level changes, newest first.
func (s *Server) handleCloudflareActivity(w http.ResponseWriter, r *http.Request) {
	account, ok := s.requireExternalAccountOwner(w, r, strings.TrimSpace(r.PathValue("accountId")))
	if !ok {
		return
	}
	if account.Provider != "cloudflare" {
		writeError(w, http.StatusNotFound, "Cloudflare account not found")
		return
	}
	events, err := s.store.ListExternalAccountEvents(r.Context(), account.ID, 1000)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	workspaces, sessions := map[string]string{}, map[string]string{}
	entries := []store.CloudflareActivityEntry{}
	for _, event := range events {
		if len(entries) == 50 {
			break
		}
		if event.Kind != connectors.CloudflareWriteEvent && event.Kind != "access_changed" {
			continue
		}
		entry := store.CloudflareActivityEntry{ID: event.ID, At: event.CreatedAt, Kind: event.Kind, SessionID: event.SessionID}
		var detail struct {
			connectors.CloudflareWriteDetail
			From string `json:"from"`
			To   string `json:"to"`
		}
		if json.Unmarshal([]byte(event.Detail), &detail) != nil {
			continue
		}
		entry.WorkspaceID, entry.Method, entry.Path, entry.ZoneID, entry.RecordID = detail.WorkspaceID, detail.Method, detail.Path, detail.ZoneID, detail.RecordID
		entry.RecordName, entry.RecordType, entry.Content, entry.Result, entry.Error = detail.RecordName, detail.RecordType, detail.Content, detail.Result, detail.Error
		entry.From, entry.To = detail.From, detail.To
		if name, seen := workspaces[entry.WorkspaceID]; seen {
			entry.WorkspaceName = name
		} else if workspace, err := s.store.GetWorkspace(r.Context(), entry.WorkspaceID); err == nil {
			entry.WorkspaceName, workspaces[entry.WorkspaceID] = workspace.Name, workspace.Name
		} else {
			workspaces[entry.WorkspaceID] = ""
		}
		if entry.SessionID != "" {
			if title, seen := sessions[entry.SessionID]; seen {
				entry.SessionTitle = title
			} else if session, err := s.store.GetAgentSessionSummary(r.Context(), entry.SessionID); err == nil && session.CreatedByUserID == account.OwnerUserID {
				entry.SessionTitle, sessions[entry.SessionID] = session.Title, session.Title
			} else {
				sessions[entry.SessionID] = ""
			}
		}
		entries = append(entries, entry)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}
