package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) workSession(call mcpCall, control bool) (store.AgentSession, error) {
	id := mcpArgString(call.args, "sessionId")
	if id == "" {
		id = call.actor.Identity.SessionID
	}
	if control {
		return s.controlledSession(call.r.Context(), call.actor, id, "control work of")
	}
	session, err := s.sessionTarget(call.r.Context(), call.actor, id, "read work of")
	if err == nil && !s.canControlSession(call.r.Context(), call.actor, session) {
		return session, &statusError{http.StatusForbidden, errors.New("membership required to inspect work commands")}
	}
	return session, err
}
func (s *Server) listWorkForMCP(call mcpCall) (string, error) {
	if workspaceID := mcpArgString(call.args, "workspaceId"); workspaceID != "" {
		scope, err := s.contextScope(call.r.Context(), call.actor)
		if err != nil || !scope.can(workspaceID, store.WorkspaceRoleMember) || scope.issueID != "" {
			return "", &statusError{http.StatusForbidden, errors.New("workspace service inventory requires workspace membership outside an Issue-scoped session")}
		}
		items, err := s.store.ListWorkspaceServices(call.r.Context(), workspaceID)
		if err != nil {
			return "", err
		}
		if id := mcpArgString(call.args, "id"); id != "" {
			for _, item := range items {
				if item.ID == id {
					runs, err := s.store.ListWorkRuns(call.r.Context(), id)
					if err != nil {
						return "", err
					}
					return encodeJSON(map[string]any{"item": item, "runs": runs})
				}
			}
			return "", &statusError{http.StatusNotFound, errors.New("service not found")}
		}
		tunnels := []map[string]any{}
		registered, err := s.store.ListServiceTunnels(call.r.Context(), workspaceID)
		if err != nil {
			return "", err
		}
		userID := call.actor.AccountID()
		if call.actor.Agent() {
			userID = scope.agentFor
		}
		for _, item := range registered {
			if s.authorizeTunnel(call.r.Context(), item, userID) && scope.can(item.TargetWorkspaceID, store.WorkspaceRoleMember) {
				_, status := s.liveTunnel(item)
				tunnels = append(tunnels, map[string]any{"service": item, "url": s.tunnelURL(item), "status": status})
			}
		}
		return encodeJSON(map[string]any{"items": items, "serviceTunnels": tunnels, "scope": "workspace_services"})
	}
	session, err := s.workSession(call, false)
	if err != nil {
		return "", err
	}
	list, err := s.sessionWorkList(call.r.Context(), session)
	if err != nil {
		return "", err
	}
	if id := mcpArgString(call.args, "id"); id != "" {
		for _, item := range list.Items {
			if item.ID == id {
				runs, err := s.store.ListWorkRuns(call.r.Context(), id)
				if err != nil {
					return "", err
				}
				return encodeJSON(struct {
					Item store.SessionWork `json:"item"`
					Runs []store.WorkRun   `json:"runs"`
				}{item, runs})
			}
		}
		return "", &statusError{http.StatusNotFound, errors.New("work not found")}
	}
	return encodeJSON(list)
}
func (s *Server) controlWorkForMCP(call mcpCall) (string, error) {
	session, err := s.workSession(call, true)
	if err != nil {
		return "", err
	}
	input := store.WorkControlInput{ExpectedReferenceRevision: int64(mcpArgNumber(call.args, "expectedReferenceRevision", 0)), RelatedSessionID: mcpArgString(call.args, "relatedSessionId"), ID: mcpArgString(call.args, "id"), Action: mcpArgString(call.args, "action"), ExpectedRevision: int64(mcpArgNumber(call.args, "expectedRevision", 0)), IdempotencyKey: mcpArgString(call.args, "idempotencyKey")}
	op, err := s.controlWork(call.r.Context(), session, input)
	if err != nil {
		return "", err
	}
	return encodeJSON(op)
}
func (s *Server) createWorkForMCP(call mcpCall) (string, error) {
	session, err := s.workSession(call, true)
	if err != nil {
		return "", err
	}
	input := createWorkInput{Title: mcpArgString(call.args, "title"), IdempotencyKey: mcpArgString(call.args, "idempotencyKey"), Kind: mcpArgString(call.args, "kind")}
	if err := json.Unmarshal(call.args["spec"], &input.Spec); err != nil {
		return "", &statusError{http.StatusBadRequest, errors.New("spec is required")}
	}
	w, err := s.createWork(call.r.Context(), session, input)
	if err != nil {
		return "", err
	}
	return encodeJSON(w)
}
