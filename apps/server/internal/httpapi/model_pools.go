package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/modelpool"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const modelPoolUsageWindow = time.Minute

func publicModelPool(pool store.StoredModelPool) store.ModelPool {
	members := make([]store.ModelPoolMember, len(pool.Members))
	for index, member := range pool.Members {
		members[index] = store.ModelPoolMember{
			Model: member.Model, TokensPerMinute: member.TokensPerMinute, Weight: member.Weight,
		}
	}
	return store.ModelPool{
		ID: pool.ID, ProviderKind: store.ModelPoolProviderKind(pool.ProviderKind), ProviderID: pool.ProviderID,
		Runtime: store.NativeRuntimeID(pool.Runtime), Label: pool.Label, Members: members,
		CreatedAt: pool.CreatedAt, UpdatedAt: pool.UpdatedAt,
	}
}

func storedModelPool(input store.ModelPoolInput, ownerUserID, id string) store.StoredModelPool {
	members := make([]store.EquivalentModelMember, len(input.Members))
	for index, member := range input.Members {
		members[index] = store.EquivalentModelMember{
			Model: strings.TrimSpace(member.Model), TokensPerMinute: member.TokensPerMinute, Weight: member.Weight,
		}
	}
	return store.StoredModelPool{
		ID: id, OwnerUserID: ownerUserID, ProviderKind: strings.TrimSpace(string(input.ProviderKind)),
		ProviderID: strings.TrimSpace(input.ProviderID), Runtime: strings.TrimSpace(input.Runtime),
		Label: strings.TrimSpace(input.Label), Members: members,
	}
}

func (s *Server) validateModelPool(ctx context.Context, m providerManager, pool store.StoredModelPool) error {
	view, err := s.providerView(ctx, m)
	if err != nil {
		return err
	}
	provider, ok := view.provider(pool.ProviderKind, pool.ProviderID)
	if !ok || provider.Runtime != pool.Runtime {
		return &statusError{http.StatusNotFound, errors.New("model provider not found: " + pool.ProviderID)}
	}
	if len(pool.Members) == 0 {
		return invalid("model pool needs at least one model")
	}
	return nil
}

func (s *Server) handleListModelPools(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	pools, err := s.store.ListModelPools(r.Context(), m.userID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	result := make([]store.ModelPool, len(pools))
	for index, pool := range pools {
		result[index] = publicModelPool(pool)
	}
	writeResult(w, result, nil)
}

func (s *Server) handleCreateModelPool(w http.ResponseWriter, r *http.Request) {
	var input store.ModelPoolInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	pool := storedModelPool(input, m.userID, "")
	if err := s.validateModelPool(r.Context(), m, pool); err != nil {
		writeResult(w, nil, err)
		return
	}
	saved, err := s.store.SaveModelPool(r.Context(), pool)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResultWithStatus(w, http.StatusCreated, publicModelPool(saved), nil)
}

func (s *Server) handleUpdateModelPool(w http.ResponseWriter, r *http.Request) {
	var input store.ModelPoolInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	current, err := s.store.GetModelPool(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrModelPoolNotFound) || err == nil && current.OwnerUserID != m.userID {
		err = &statusError{http.StatusNotFound, store.ErrModelPoolNotFound}
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	pool := storedModelPool(input, m.userID, current.ID)
	pool.CreatedAt = current.CreatedAt
	pool.Cursor = current.Cursor
	if err := s.validateModelPool(r.Context(), m, pool); err != nil {
		writeResult(w, nil, err)
		return
	}
	saved, err := s.store.SaveModelPool(r.Context(), pool)
	writeResult(w, publicModelPool(saved), err)
}

func (s *Server) handleDeleteModelPool(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err == nil {
		err = s.store.DeleteModelPool(r.Context(), r.PathValue("id"), m.userID)
	}
	if errors.Is(err, store.ErrModelPoolNotFound) {
		err = &statusError{http.StatusNotFound, store.ErrModelPoolNotFound}
	}
	writeResult(w, map[string]string{"deleted": r.PathValue("id")}, err)
}

// modelPoolOwner resolves the person whose pool a session-scoped caller may
// use. It is deliberately narrower than provider management: an Issue child
// may execute with a supplied pool but cannot edit the person's providers.
func (s *Server) modelPoolOwner(ctx context.Context, actor Actor) (string, error) {
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
	return "", &statusError{http.StatusForbidden, errors.New("model pools need a person's session")}
}

func (s *Server) ownedModelPool(ctx context.Context, actor Actor, id string) (store.StoredModelPool, error) {
	owner, err := s.modelPoolOwner(ctx, actor)
	if err != nil {
		return store.StoredModelPool{}, err
	}
	pool, err := s.store.GetModelPool(ctx, id)
	if errors.Is(err, store.ErrModelPoolNotFound) || err == nil && pool.OwnerUserID != owner {
		return store.StoredModelPool{}, &statusError{http.StatusNotFound, store.ErrModelPoolNotFound}
	}
	return pool, err
}

func poolModel(pool store.StoredModelPool) modelpool.Pool {
	members := make([]modelpool.Member, len(pool.Members))
	for index, member := range pool.Members {
		members[index] = modelpool.Member{
			Model: member.Model, TokensPerMinute: member.TokensPerMinute, Weight: member.Weight,
		}
	}
	return modelpool.Pool{Members: members}
}

func (s *Server) chooseModelPoolMember(ctx context.Context, pool store.StoredModelPool, current string) (string, error) {
	models := make([]string, len(pool.Members))
	for index, member := range pool.Members {
		models[index] = member.Model
	}
	used, err := s.store.RecentModelTokens(ctx, time.Now().UTC().Add(-modelPoolUsageWindow),
		pool.OwnerUserID, pool.ProviderID, pool.Runtime, models)
	if err != nil {
		return "", err
	}
	cursor := 0
	hasQuota := false
	for _, member := range pool.Members {
		hasQuota = hasQuota || member.TokensPerMinute > 0
	}
	if !hasQuota {
		cursor, err = s.store.AdvanceModelPoolCursor(ctx, pool.ID, len(pool.Members))
		if err != nil {
			return "", err
		}
	}
	var decision modelpool.Decision
	var ok bool
	if current == "" {
		decision, ok = modelpool.Choose(poolModel(pool), used, cursor)
	} else {
		decision, ok = modelpool.Next(poolModel(pool), current, used, cursor)
	}
	if !ok {
		return "", errors.New("model pool has no usable model")
	}
	return decision.Model, nil
}

func (s *Server) selectModelPool(ctx context.Context, actor Actor, poolID, current string) (store.StoredModelPool, string, error) {
	pool, err := s.ownedModelPool(ctx, actor, strings.TrimSpace(poolID))
	if err != nil {
		return store.StoredModelPool{}, "", err
	}
	model, err := s.chooseModelPoolMember(ctx, pool, current)
	if err != nil {
		return store.StoredModelPool{}, "", err
	}
	return pool, model, nil
}
