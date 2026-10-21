package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Links provide context; they never grant the caller control of a session,
// ownership of a service, or permission to copy another workspace's content.
func (s *Server) validateAssistantItemPlan(ctx context.Context, userID, itemID string, plan *store.PersonalAgentItemPlan) error {
	if !slices.Contains([]string{"record", "execute"}, plan.Mode) ||
		!slices.Contains([]string{"inbox", "ready", "waiting", "working", "review"}, plan.Progress) {
		return invalid("plan requires mode record/execute and progress inbox/ready/waiting/working/review")
	}
	if len(plan.NextAction) > 2000 || len(plan.WaitingFor) > 1000 ||
		len(plan.WorkRefs) > 32 || len(plan.Evidence) > 32 {
		return invalid("plan exceeds its size limits")
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		return err
	}
	if plan.WorkspaceID != "" && roles[plan.WorkspaceID] == "" {
		return &statusError{http.StatusNotFound, store.ErrNotFound}
	}
	if route := plan.Route; route != nil {
		if !slices.Contains([]string{"record", "continue", "existing", "create", "multiple", "clarify"}, route.Kind) || strings.TrimSpace(route.Reason) == "" || len(route.Reason) > 2000 || len(route.Alternatives) > 8 {
			return invalid("invalid routing decision")
		}
		for _, candidate := range route.Alternatives {
			if roles[candidate] == "" {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
		}
		if route.Kind == "clarify" {
			route.NeedsClarification = true
		}
	}
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	actor := Actor{Kind: ActorAccount, Account: &user}
	for _, ref := range plan.WorkRefs {
		if ref.ID == "" || ref.WorkspaceID == "" || roles[ref.WorkspaceID] == "" ||
			!slices.Contains([]string{"observing", "executing", "dependency"}, ref.Relation) {
			return invalid("invalid work reference")
		}
		switch ref.Kind {
		case "session":
			session, err := s.store.GetAgentSessionSummary(ctx, ref.ID)
			if err != nil || session.WorkspaceID != ref.WorkspaceID || !s.canReadSession(ctx, actor, session) {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
			if ref.Relation == "executing" && !s.canControlSession(ctx, actor, session) {
				return invalid("this session may only be observed")
			}
		case "issue":
			issue, err := s.store.GetIssue(ctx, ref.ID)
			if err != nil || issue.WorkspaceID != ref.WorkspaceID {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
		case "service":
			backing, err := s.workStore()
			if err != nil {
				return err
			}
			services, err := backing.ListWorkspaceServices(ctx, ref.WorkspaceID)
			if err != nil {
				return err
			}
			if !slices.ContainsFunc(services, func(work store.SessionWork) bool { return work.ID == ref.ID }) {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
			if ref.Relation == "executing" {
				return invalid("a service reference observes its independent lifecycle")
			}
		default:
			return invalid("work reference kind must be session, issue or service")
		}
	}
	for _, evidence := range plan.Evidence {
		if !slices.Contains([]string{"session", "issue", "file", "url", "user"}, evidence.Kind) ||
			strings.TrimSpace(evidence.Ref) == "" || len(evidence.Ref) > 2000 || len(evidence.Summary) > 2000 {
			return invalid("invalid evidence reference")
		}
		if _, err := time.Parse(time.RFC3339, evidence.ObservedAt); err != nil {
			return invalid("evidence requires an observation time")
		}
		switch evidence.Kind {
		case "session":
			id, input, _ := strings.Cut(evidence.Ref, "#")
			session, e := s.store.GetAgentSessionSummary(ctx, id)
			if e != nil || !s.canReadSession(ctx, actor, session) {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
			if session.Status != "completed" || (input != "" && session.Input.ID != input) {
				return invalid("completion evidence must point to a completed current input; use a file artifact for historical outputs")
			}
		case "issue":
			issue, e := s.store.GetIssue(ctx, evidence.Ref)
			if e != nil || roles[issue.WorkspaceID] == "" {
				return &statusError{http.StatusNotFound, store.ErrNotFound}
			}
		case "url":
			u, e := url.Parse(evidence.Ref)
			if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
				return invalid("evidence link must be an HTTP(S) URL without credentials")
			}
		case "file":
			if plan.WorkspaceID == "" || strings.HasPrefix(evidence.Ref, "/") || strings.Contains(evidence.Ref, "\\") {
				return invalid("file evidence needs a relative path in the selected workspace")
			}
			for _, part := range strings.Split(evidence.Ref, "/") {
				if part == ".." {
					return invalid("file evidence cannot escape its workspace")
				}
			}
		}
	}
	items, err := s.store.ListPersonalAgentItems(ctx, userID, "0001-01-01")
	if err != nil {
		return err
	}
	graph := map[string][]string{}
	for _, item := range items {
		graph[item.ID] = nil
		if item.Plan != nil {
			graph[item.ID] = item.Plan.Dependencies
		}
	}
	if itemID == "" {
		itemID = "new-item"
	}
	graph[itemID] = plan.Dependencies
	if err := flow.CheckItemDependencies(itemID, graph); err != nil {
		return invalid("%v", err)
	}
	return nil
}
