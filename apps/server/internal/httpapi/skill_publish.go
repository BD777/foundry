package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type promotionSource struct {
	input  store.PromoteSkillInput
	graph  []store.DeviceSkill
	drafts map[string]store.WorkspaceDraftSkill
}

func conflict(message string) error { return &statusError{http.StatusConflict, errors.New(message)} }

// Resolve IDs from the recorded scan. In particular, a draft caller never supplies
// the directory or snapshot read by the worker.
func (s *Server) publicationSource(ctx context.Context, actor Actor, input store.PromoteSkillInput) (promotionSource, error) {
	p := promotionSource{input: input}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return p, err
	}
	if input.DraftID != "" {
		if input.Root != "" || input.DirName != "" || input.DeviceID != "" {
			return p, badRequest("choose a draft or device source")
		}
		if err := workspaceRefusal(scope, input.SourceWorkspaceID, store.WorkspaceRoleViewer); err != nil {
			return p, err
		}
		ws, err := s.store.GetWorkspace(ctx, input.SourceWorkspaceID)
		if err != nil {
			return p, err
		}
		p.input.DeviceID = ws.DeviceID
	} else if input.DeviceID == "" || input.Root == "" || input.DirName == "" || input.SourceWorkspaceID != "" {
		return p, badRequest("deviceId, root and dirName or sourceWorkspaceId and draftId are required")
	}
	// A normal agent may publish on behalf of the device owner. Check that
	// person's current ownership and the session's own workspace boundary.
	if actor.Agent() {
		session, err := s.store.GetAgentSessionRecord(ctx, actor.Identity.SessionID)
		if err != nil {
			return p, err
		}
		if session.WorkspaceAccess == store.SessionWorkspaceAccessRead {
			return p, &statusError{http.StatusForbidden, errors.New("a read-only session cannot publish skills")}
		}
		manager, err := s.providerManagerFor(ctx, actor)
		if err != nil || !manager.owned[p.input.DeviceID] {
			return p, &statusError{http.StatusForbidden, errors.New("publication requires the device owner")}
		}
		if scope.assistant.Applicable {
			view, err := s.visibilityFor(ctx, actor)
			if err != nil {
				return p, err
			}
			if !view.seesDevice(p.input.DeviceID) {
				return p, &statusError{http.StatusForbidden, errors.New("device outside assistant scope")}
			}
		}
	} else {
		if !scope.ownsDevice(p.input.DeviceID) {
			owner, err := s.store.DeviceOwner(ctx, p.input.DeviceID)
			if err != nil || !scope.admin || owner != "" {
				return p, store.ErrNotFound
			}
		}
	}
	if input.WorkspaceID != "" {
		if err := workspaceRefusal(scope, input.WorkspaceID, store.WorkspaceRoleMaintainer); err != nil {
			return p, err
		}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, p.input.DeviceID); err != nil {
		return p, err
	}
	if input.DraftID == "" {
		p.graph, err = s.store.ListDeviceSkills(ctx, p.input.DeviceID)
		return p, err
	}
	view, err := s.store.WorkspaceDrafts(ctx, input.SourceWorkspaceID, input.SourceWorkspaceID)
	if err != nil {
		return p, err
	}
	catalog, err := s.store.ListPromotedSkills(ctx)
	if err != nil {
		return p, err
	}
	p.drafts = map[string]store.WorkspaceDraftSkill{}
	for _, draft := range view.Skills {
		if draft.ID == input.DraftID {
			p.input.Root = input.SourceWorkspaceID
			p.input.DirName = draft.RelativePath
		}
		source := store.DeviceSkill{Root: input.SourceWorkspaceID, DirName: draft.RelativePath, DeviceID: p.input.DeviceID, Name: draft.Name, Description: draft.Description, SourceDigest: draft.SourceDigest, DependenciesAnalyzed: draft.DependenciesAnalyzed, Dependencies: draft.Dependencies, LibraryRelation: draft.LibraryRelation}
		if draft.Status != "ready" {
			source.DependencyAnalysisError = "draft is " + draft.Status + ": " + draft.Error
		}
		if !draft.DependenciesAnalyzed {
			source.DependencyAnalysisError = "refresh workspace drafts with an updated worker before publishing"
		}
		var linked store.PromotedSkill
		var candidates []store.PromotedSkill
		for _, candidate := range catalog {
			if draft.LibraryRelation != nil && draft.LibraryRelation.BaseRevision > 0 && draft.LibraryRelation.SkillID == candidate.ID {
				linked = candidate
				source.PromotedSkillID = candidate.ID
			}
			if strings.EqualFold(candidate.Name, source.Name) {
				candidates = append(candidates, candidate)
			}
		}
		source.SetPromotionCandidates(candidates, linked, "", "")
		p.graph = append(p.graph, source)
		p.drafts[draft.RelativePath] = draft
	}
	if p.input.DirName == "" {
		return p, store.ErrNotFound
	}
	// Required library dependencies are already immutable. Keep them as reuse
	// nodes so selecting the closure adds them to the destination workspace.
	refs, _, err := workspaceSkillRefs(ctx, s.store, input.SourceWorkspaceID)
	if err != nil {
		return p, err
	}
	for _, ref := range refs {
		for _, item := range catalog {
			if ref.SkillID == item.ID {
				source := store.DeviceSkill{DeviceID: p.input.DeviceID, Root: "library", DirName: ref.Name + "@" + ref.SourceDigest, Name: ref.Name, Description: item.Description, PromotedSkillID: item.ID, SourceDigest: ref.SourceDigest, ServerState: "in_sync", DependenciesAnalyzed: true, ServerCandidates: []store.PromotedSkill{item}}
				if ref.Revision != item.LatestRevision {
					source.DependencyAnalysisError = "refresh against the latest library dependency before publishing"
				}
				p.graph = append(p.graph, source)
				break
			}
		}
	}
	return p, nil
}

func (s *Server) readPromotionSource(ctx context.Context, p promotionSource, source store.DeviceSkill) (wsSkillContentReadPayload, error) {
	if p.drafts == nil {
		return s.hub.ReadDeviceSkillContent(ctx, p.input.DeviceID, source.Root, source.DirName)
	}
	draft, ok := p.drafts[source.DirName]
	if !ok || source.Root != p.input.SourceWorkspaceID {
		return wsSkillContentReadPayload{}, store.ErrNotFound
	}
	conn := s.hub.connectionFor(p.input.DeviceID)
	if conn == nil {
		return wsSkillContentReadPayload{}, conflict("connect the workspace worker to read its draft snapshot")
	}
	request, err := json.Marshal(wsReadSkillContentPayload{Draft: &draft})
	if err != nil {
		return wsSkillContentReadPayload{}, err
	}
	answer, err := daemonRequest[wsSkillContentReadPayload](ctx, conn, wsReadSkillContentType, request)
	if err == nil && answer.Error != "" {
		err = conflict(answer.Error)
	}
	return answer, err
}

func (s *Server) publishSkillForMCP(call mcpCall) (string, error) {
	raw, err := json.Marshal(call.args)
	if err != nil {
		return "", err
	}
	var input struct {
		store.PromoteSkillInput
		Preview bool `json:"preview"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return "", badRequest(err.Error())
	}
	if input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		return "", badRequest("expectedRevision is required (0 for a new skill)")
	}
	if input.DraftID != "" && input.SourceWorkspaceID == "" {
		input.SourceWorkspaceID = call.actor.Identity.WorkspaceID
	}
	ctx := call.r.Context()
	p, err := s.publicationSource(ctx, call.actor, input.PromoteSkillInput)
	if err != nil {
		return "", err
	}
	if input.Preview {
		plan, err := s.storedSkillPromotionPlan(ctx, &p)
		if err != nil {
			return "", err
		}
		sources := []map[string]any{}
		for _, item := range plan.Skills {
			candidates := []map[string]any{}
			for _, c := range item.ServerCandidates {
				candidates = append(candidates, map[string]any{"id": c.ID, "latestRevision": c.LatestRevision})
			}
			sources = append(sources, map[string]any{"root": item.Root, "dirName": item.DirName, "name": item.Name, "candidates": candidates, "relation": item.LibraryRelation})
		}
		return encodeJSON(map[string]any{"planDigest": plan.Digest, "skills": sources, "problems": plan.Problems})
	}
	item, err := s.publishSkill(ctx, call.actor, input.PromoteSkillInput, p)
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"skillId": item.ID, "revision": item.LatestRevision, "name": item.Name, "workspaceId": input.WorkspaceID})
}
