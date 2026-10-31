package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"time"
)

const workspaceDraftCapability = "workspace_draft_skills_v1"

type workspaceDraftReply struct {
	store.WorkspaceDraftSkills
	Error string `json:"error,omitempty"`
}

func (s *Server) workspaceDraftView(ctx context.Context, id string, refresh bool) (store.WorkspaceDraftSkills, error) {
	return s.executionDraftView(ctx, id, "", refresh)
}

func (s *Server) executionDraftView(ctx context.Context, id, issueID string, refresh bool) (store.WorkspaceDraftSkills, error) {
	rootID := id
	if issueID != "" {
		rootID = "issue:" + issueID
	}
	backing, ok := s.store.(store.WorkspaceDraftStore)
	if !ok {
		return store.WorkspaceDraftSkills{}, errors.New("workspace draft storage unavailable")
	}
	workspace, err := s.store.GetWorkspace(ctx, id)
	if err != nil {
		return store.WorkspaceDraftSkills{}, err
	}
	view, err := backing.WorkspaceDrafts(ctx, id, rootID)
	if err != nil {
		return view, err
	}
	c := s.hub.connectionFor(workspace.DeviceID)
	view.Supported = c != nil && c.hasCapability(workspaceDraftCapability)
	if !refresh {
		return view, nil
	}
	if !view.Supported {
		return view, &statusError{http.StatusConflict, errors.New("connect and update the workspace worker to use draft skills")}
	}
	if !view.Enabled {
		return view, &statusError{http.StatusConflict, errors.New("workspace draft skills are disabled")}
	}
	refs, _, err := workspaceSkillRefs(ctx, s.store, id)
	if err != nil {
		return view, err
	}
	request, _ := json.Marshal(map[string]any{"workspaceId": id, "issueId": issueID, "libraryRefs": refs})
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	answer, err := daemonRequest[workspaceDraftReply](ctx, c, wsRefreshWorkspaceSkillsType, request)
	if err != nil {
		return view, err
	}
	if answer.Error != "" {
		return view, errors.New(answer.Error)
	}
	for _, draft := range answer.Skills {
		if draft.WorkspaceID != id || draft.ExecutionRootID != rootID {
			return view, errors.New("draft scan returned another execution root")
		}
	}
	for i := range answer.Skills {
		for _, old := range view.Skills {
			if old.ID == answer.Skills[i].ID {
				if old.Digest != "" && old.Digest != answer.Skills[i].Digest {
					answer.Skills[i].PreviousDigest = old.Digest
				} else {
					answer.Skills[i].PreviousDigest = old.PreviousDigest
				}
			}
		}
	}
	current, err := backing.WorkspaceDrafts(ctx, id, rootID)
	if err != nil {
		return view, err
	}
	if !current.Enabled {
		return view, &statusError{http.StatusConflict, errors.New("workspace drafts were disabled during refresh")}
	}
	answer.Enabled = current.Enabled
	answer.Supported = true
	if err = backing.SaveWorkspaceDrafts(ctx, id, rootID, answer.WorkspaceDraftSkills); err != nil {
		return view, err
	}
	return answer.WorkspaceDraftSkills, nil
}
func (s *Server) handleWorkspaceDraftSkills(w http.ResponseWriter, r *http.Request) {
	view, err := s.workspaceDraftView(r.Context(), r.PathValue("id"), r.Method == http.MethodPost)
	writeResult(w, view, err)
}
func (s *Server) handleSetWorkspaceDraftSkills(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	backing, ok := s.store.(store.WorkspaceDraftStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "draft storage unavailable")
		return
	}
	if err := backing.SetWorkspaceDraftsEnabled(r.Context(), r.PathValue("id"), *input.Enabled); err != nil {
		writeResult(w, nil, err)
		return
	}
	view, err := s.workspaceDraftView(r.Context(), r.PathValue("id"), false)
	writeResult(w, view, err)
}
func (s *Server) refreshWorkspaceSkillsForMCP(call mcpCall) (string, error) {
	if !call.actor.Agent() {
		return "", &statusError{http.StatusBadRequest, errors.New("this tool requires a current Foundry session")}
	}
	session, err := store.AgentSessionRecord(call.r.Context(), s.store, call.actor.Identity.SessionID)
	if err != nil {
		return "", err
	}
	if session.Source == verificationSource {
		return "", &statusError{http.StatusConflict, errors.New("this execution root does not support draft refresh yet")}
	}
	scope, err := s.contextScope(call.r.Context(), call.actor)
	if err != nil {
		return "", err
	}
	if !scope.can(session.WorkspaceID, store.WorkspaceRoleMember) {
		return "", &statusError{http.StatusForbidden, errors.New("workspace membership required")}
	}
	view, err := s.executionDraftView(call.r.Context(), session.WorkspaceID, session.IssueID, true)
	if err != nil {
		return "", err
	}
	return encodeJSON(view)
}
