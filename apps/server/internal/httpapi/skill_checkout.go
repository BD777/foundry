package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const workspaceSkillCheckoutCapability = "workspace_skill_checkout"

type checkoutSkillInput struct {
	SkillID  string `json:"skillId"`
	Revision *int   `json:"revision,omitempty"`
}

type checkedOutSkill struct {
	store.SkillCheckoutBaseline
	RelativePath string `json:"relativePath"`
	WorkspaceID  string `json:"workspaceId"`
}

type wsWorkspaceSkillCheckedOut struct {
	wsReplyError
	DirectoryID string `json:"directoryId,omitempty"`
}

type wsCheckoutWorkspaceSkillPayload struct {
	IssueID     string                `json:"issueId,omitempty"`
	WorkspaceID string                `json:"workspaceId"`
	Ref         store.SessionSkillRef `json:"ref"`
}

func (s *Server) checkoutSkill(ctx context.Context, workspaceID, issueID string, input checkoutSkillInput) (checkedOutSkill, error) {
	var out checkedOutSkill
	if workspaceID == "" || strings.TrimSpace(input.SkillID) == "" || (input.Revision != nil && *input.Revision < 1) {
		return out, &statusError{http.StatusBadRequest, errors.New("workspaceId, skillId and a positive revision (if specified) are required")}
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return out, err
	}
	c := s.hub.connectionFor(workspace.DeviceID)
	if c == nil || !c.hasCapability(workspaceSkillCheckoutCapability) {
		return out, &statusError{http.StatusConflict, errors.New("connect and update the workspace worker to check out skills")}
	}
	if issueID != "" && !c.hasCapability("issue_skill_checkout") {
		return out, &statusError{http.StatusConflict, errors.New("update the workspace worker to check out skills in an Issue candidate")}
	}
	skill, err := s.store.GetPromotedSkill(ctx, input.SkillID)
	if err != nil {
		return out, err
	}
	revision := skill.LatestRevision
	if input.Revision != nil {
		revision = *input.Revision
	}
	refs, err := s.store.SkillRevisionRefs(ctx, []store.SkillBundleMember{{SkillID: skill.ID, Revision: revision}})
	if err != nil {
		return out, err
	}
	if len(refs) != 1 {
		return out, &statusError{http.StatusNotFound, errors.New("library revision not found")}
	}
	request, err := json.Marshal(wsCheckoutWorkspaceSkillPayload{WorkspaceID: workspaceID, IssueID: issueID, Ref: refs[0]})
	if err != nil {
		return out, err
	}
	// Once dispatched, a browser disconnect must not discard the Worker's
	// acknowledgement or the baseline belonging to the directory it created.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	reply, err := daemonRequest[wsWorkspaceSkillCheckedOut](ctx, c, wsCheckoutWorkspaceSkillType, request)
	if err != nil {
		return out, err
	}
	if reply.Error != "" {
		return out, &statusError{http.StatusConflict, errors.New(reply.Error)}
	}
	if reply.DirectoryID == "" {
		return out, errors.New("worker omitted checkout directory identity")
	}
	out = checkedOutSkill{WorkspaceID: workspaceID, RelativePath: path.Join(".agents/skills", refs[0].Name), SkillCheckoutBaseline: store.SkillCheckoutBaseline{SkillID: skill.ID, Revision: revision, CheckoutDirectoryID: reply.DirectoryID}}
	// Candidate drafts belong to the Issue and never replace a workspace checkout baseline.
	if issueID != "" {
		return out, nil
	}
	if err := s.store.SaveWorkspaceSkillCheckout(ctx, workspaceID, out.RelativePath, out.SkillCheckoutBaseline); err != nil {
		return out, fmt.Errorf("draft created at %s; refresh workspace skills to recover its checkout baseline: %w", out.RelativePath, err)
	}
	return out, nil
}

func (s *Server) handleCheckoutSkill(w http.ResponseWriter, r *http.Request) {
	var input checkoutSkillInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	out, err := s.checkoutSkill(r.Context(), r.PathValue("id"), "", input)
	writeResult(w, out, err)
}

func (s *Server) checkoutSkillForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	workspaceID := mcpArgString(call.args, "workspaceId")
	scope, err := s.contextScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	if !scope.can(workspaceID, store.WorkspaceRoleMember) {
		return "", &statusError{http.StatusForbidden, errors.New("writable workspace membership required")}
	}
	if call.actor.Agent() {
		session, err := s.store.GetAgentSessionRecord(ctx, call.actor.Identity.SessionID)
		if err != nil {
			return "", err
		}
		if session.WorkspaceAccess == store.SessionWorkspaceAccessRead || session.Source == store.SessionSourceVerification {
			return "", &statusError{http.StatusForbidden, errors.New("this session cannot change workspace files")}
		}
	}
	input := checkoutSkillInput{SkillID: mcpArgString(call.args, "skillId")}
	if raw, ok := call.args["revision"]; ok {
		var revision int
		if err := json.Unmarshal(raw, &revision); err != nil {
			return "", &statusError{http.StatusBadRequest, errors.New("revision must be a positive integer")}
		}
		input.Revision = &revision
	}
	out, err := s.checkoutSkill(ctx, workspaceID, scope.issueID, input)
	if err != nil {
		return "", err
	}
	return encodeJSON(out)
}
