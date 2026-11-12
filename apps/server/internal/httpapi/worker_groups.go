package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const workerGroupUsageWindow = time.Minute

func publicWorkerGroup(group store.StoredWorkerGroup) store.WorkerGroup {
	return store.WorkerGroup{
		ID: group.ID, Label: group.Label, Members: group.Members,
		CreatedAt: group.CreatedAt, UpdatedAt: group.UpdatedAt,
	}
}

func storedWorkerGroup(input store.WorkerGroupInput, ownerUserID, id string) store.StoredWorkerGroup {
	members := make([]store.WorkerGroupMember, len(input.Members))
	for index, member := range input.Members {
		member.ProviderID = strings.TrimSpace(member.ProviderID)
		member.Model = strings.TrimSpace(member.Model)
		member.Effort = strings.TrimSpace(member.Effort)
		members[index] = member
	}
	return store.StoredWorkerGroup{ID: id, OwnerUserID: ownerUserID, Label: strings.TrimSpace(input.Label), Members: members}
}

// validateWorkerGroup checks every member against the person's providers: it
// must exist with that runtime, and its effort must suit the runtime.
func (s *Server) validateWorkerGroup(ctx context.Context, m providerManager, group store.StoredWorkerGroup) error {
	if len(group.Members) == 0 {
		return invalid("a worker group needs at least one member")
	}
	view, err := s.providerView(ctx, m)
	if err != nil {
		return err
	}
	for _, member := range group.Members {
		provider, ok := view.provider(string(member.ProviderKind), member.ProviderID)
		if !ok || provider.Runtime != string(member.Runtime) {
			return &statusError{http.StatusNotFound, errors.New("model provider not found: " + member.ProviderID)}
		}
		if err := checkEffort(string(member.Runtime), member.Effort); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleListWorkerGroups(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	groups, err := s.store.ListWorkerGroups(r.Context(), m.userID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	result := make([]store.WorkerGroup, len(groups))
	for index, group := range groups {
		result[index] = publicWorkerGroup(group)
	}
	writeResult(w, result, nil)
}

func (s *Server) handleCreateWorkerGroup(w http.ResponseWriter, r *http.Request) {
	var input store.WorkerGroupInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	group := storedWorkerGroup(input, m.userID, "")
	if err := s.validateWorkerGroup(r.Context(), m, group); err != nil {
		writeResult(w, nil, err)
		return
	}
	saved, err := s.store.SaveWorkerGroup(r.Context(), group)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResultWithStatus(w, http.StatusCreated, publicWorkerGroup(saved), nil)
}

func (s *Server) handleUpdateWorkerGroup(w http.ResponseWriter, r *http.Request) {
	var input store.WorkerGroupInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	current, err := s.store.GetWorkerGroup(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrWorkerGroupNotFound) || err == nil && current.OwnerUserID != m.userID {
		err = &statusError{http.StatusNotFound, store.ErrWorkerGroupNotFound}
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	group := storedWorkerGroup(input, m.userID, current.ID)
	group.CreatedAt = current.CreatedAt
	group.Cursor = current.Cursor
	if err := s.validateWorkerGroup(r.Context(), m, group); err != nil {
		writeResult(w, nil, err)
		return
	}
	saved, err := s.store.SaveWorkerGroup(r.Context(), group)
	writeResult(w, publicWorkerGroup(saved), err)
}

func (s *Server) handleDeleteWorkerGroup(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err == nil {
		err = s.store.DeleteWorkerGroup(r.Context(), r.PathValue("id"), m.userID)
	}
	if errors.Is(err, store.ErrWorkerGroupNotFound) {
		err = &statusError{http.StatusNotFound, store.ErrWorkerGroupNotFound}
	}
	writeResult(w, map[string]string{"deleted": r.PathValue("id")}, err)
}

// workerGroupOwner resolves the person whose group a session-scoped caller may
// use. It is deliberately narrower than provider management: an Issue child
// may execute with a supplied group but cannot edit the person's providers.
func (s *Server) workerGroupOwner(ctx context.Context, actor Actor) (string, error) {
	if actor.Account != nil {
		return actor.Account.ID, nil
	}
	if actor.Agent() {
		session, err := s.store.GetAgentSessionSummary(ctx, actor.Identity.SessionID)
		if err != nil {
			return "", err
		}
		if session.CreatedByUserID != "" {
			return session.CreatedByUserID, nil
		}
	}
	return "", &statusError{http.StatusForbidden, errors.New("worker groups need a person's session")}
}

func (s *Server) ownedWorkerGroup(ctx context.Context, actor Actor, id string) (store.StoredWorkerGroup, error) {
	owner, err := s.workerGroupOwner(ctx, actor)
	if err != nil {
		return store.StoredWorkerGroup{}, err
	}
	group, err := s.store.GetWorkerGroup(ctx, id)
	if errors.Is(err, store.ErrWorkerGroupNotFound) || err == nil && group.OwnerUserID != owner {
		return store.StoredWorkerGroup{}, &statusError{http.StatusNotFound, store.ErrWorkerGroupNotFound}
	}
	return group, err
}

// workerGroupMemberKey names a member in the usage map; the same model on
// two providers has separate quota.
func workerGroupMemberKey(member store.WorkerGroupMember) string {
	return string(member.ProviderKind) + "\x00" + member.ProviderID + "\x00" + string(member.Runtime) + "\x00" + member.Model
}

// memberAvailability says whether a member's provider can run on the device
// whose accounts are given, and if not why: the same account list a session
// without a profile is placed by (workspaceAccounts).
func memberAvailability(accounts []workspaceAccount, member store.WorkerGroupMember) (bool, string) {
	for _, account := range accounts {
		if account.ProfileID != member.ProviderID || account.Runtime != string(member.Runtime) {
			continue
		}
		if (member.ProviderKind == store.WorkerGroupMemberProviderKindAPI) != (account.Kind == "model_service") {
			continue
		}
		if account.Usable {
			return true, ""
		}
		reason := strings.ReplaceAll(account.Problem, "_", " ")
		if account.Detail != "" {
			reason += ": " + account.Detail
		}
		return false, reason
	}
	if member.ProviderKind == store.WorkerGroupMemberProviderKindAPI {
		return false, "not assigned to this device"
	}
	return false, "not found on this device"
}

// noWorkerGroupMemberError refuses a start no member of the group can serve,
// listing every member with its reason, so the caller can fix a provider or
// pick another group instead of being given some other model.
type noWorkerGroupMemberError struct {
	group, device string
	reasons       []string
}

func (e *noWorkerGroupMemberError) Error() string {
	return fmt.Sprintf("no_usable_worker_group_member: no member of worker group %q can run on %q now: %s",
		e.group, e.device, strings.Join(e.reasons, "; "))
}

type workerGroupChoice struct {
	Group  store.StoredWorkerGroup
	Member store.WorkerGroupMember
}

func (s *Server) chooseWorkerGroupMember(ctx context.Context, group store.StoredWorkerGroup, workspace store.WorkspaceProjection) (store.WorkerGroupMember, error) {
	accounts, err := s.workspaceAccounts(ctx, workspace, group.OwnerUserID)
	if err != nil {
		return store.WorkerGroupMember{}, err
	}
	var candidates []store.WorkerGroupMember
	var reasons []string
	for _, member := range group.Members {
		ok, reason := memberAvailability(accounts, member)
		if !ok {
			reasons = append(reasons, fmt.Sprintf("%s on %s (%s)", member.Model, member.ProviderID, reason))
			continue
		}
		candidates = append(candidates, member)
	}
	if len(candidates) == 0 {
		return store.WorkerGroupMember{}, &statusError{http.StatusConflict, &noWorkerGroupMemberError{
			group: group.Label, device: workspace.DeviceLabel, reasons: reasons,
		}}
	}
	type route struct{ providerID, runtime string }
	models := map[route][]string{}
	for _, member := range candidates {
		key := route{member.ProviderID, string(member.Runtime)}
		models[key] = append(models[key], member.Model)
	}
	used := map[string]int64{}
	since := time.Now().UTC().Add(-workerGroupUsageWindow)
	for key, ids := range models {
		tokens, err := s.store.RecentModelTokens(ctx, since, group.OwnerUserID, key.providerID, key.runtime, ids)
		if err != nil {
			return store.WorkerGroupMember{}, err
		}
		for _, member := range candidates {
			if member.ProviderID == key.providerID && string(member.Runtime) == key.runtime {
				used[workerGroupMemberKey(member)] = tokens[member.Model]
			}
		}
	}
	members := make([]modelpool.Member, len(candidates))
	hasQuota, totalWeight := false, 0
	for index, member := range candidates {
		weight := max(member.Weight, 1)
		members[index] = modelpool.Member{
			Key: workerGroupMemberKey(member), Model: member.Model, TokensPerMinute: member.TokensPerMinute, Weight: weight,
		}
		hasQuota = hasQuota || member.TokensPerMinute > 0
		totalWeight += weight
	}
	cursor := 0
	if !hasQuota {
		if cursor, err = s.store.AdvanceWorkerGroupCursor(ctx, group.ID, totalWeight); err != nil {
			return store.WorkerGroupMember{}, err
		}
	}
	decision, ok := modelpool.Choose(modelpool.Pool{Members: members}, used, cursor)
	if !ok {
		return store.WorkerGroupMember{}, errors.New("worker group has no usable member")
	}
	return candidates[decision.Index], nil
}

// selectWorkerGroup is the member a new session in the workspace starts on:
// among the members whose provider runs on the workspace's device, by
// remaining quota or weight.
func (s *Server) selectWorkerGroup(ctx context.Context, actor Actor, groupID, workspaceID string) (workerGroupChoice, error) {
	group, err := s.ownedWorkerGroup(ctx, actor, strings.TrimSpace(groupID))
	if err != nil {
		return workerGroupChoice{}, err
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return workerGroupChoice{}, &statusError{http.StatusNotFound, errors.New("workspace not found")}
	}
	member, err := s.chooseWorkerGroupMember(ctx, group, workspace)
	if err != nil {
		return workerGroupChoice{}, err
	}
	return workerGroupChoice{Group: group, Member: member}, nil
}
