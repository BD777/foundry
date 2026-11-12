package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Model guides (contracts/models/model_guides.yaml): what an orchestrator
// reads before handing work to a model. The person reads them over HTTP; the
// model_guides MCP tool (mcp_model_guides.go) reads and writes them.

const (
	modelGuideUsageWindowDays = 30
	defaultModelObservations  = 20
	maxModelObservations      = 50
	maxModelGuideBatch        = 200
)

func modelGuideSummary(guide store.ModelGuide) store.ModelGuideSummary {
	return store.ModelGuideSummary{
		ID: guide.ID, Owner: guide.Owner, DisplayName: guide.DisplayName, Family: guide.Family,
		AliasCount: len(guide.Aliases), Summary: guide.Sections.Summary, Revision: guide.Revision,
		UpdatedAt: guide.UpdatedAt, UpdatedBy: guide.UpdatedBy,
	}
}

func modelGuideOwner(s *Server, ctx context.Context, actor Actor) (string, error) {
	m, err := s.providerManagerFor(ctx, actor)
	return m.userID, err
}

// modelGuideUpdater names who writes a revision: the person, and the session
// when an agent writes for them.
func (s *Server) modelGuideUpdater(ctx context.Context, actor Actor, ownerUserID string) (store.ModelGuideUpdater, error) {
	user, err := s.store.GetUser(ctx, ownerUserID)
	if err != nil {
		return store.ModelGuideUpdater{}, err
	}
	updater := store.ModelGuideUpdater{UserID: user.ID, Name: user.DisplayName}
	if actor.Agent() {
		updater.SessionID = actor.Identity.SessionID
	}
	return updater, nil
}

func modelGuideNotFound(err error) error {
	if errors.Is(err, store.ErrModelGuideNotFound) {
		return &statusError{http.StatusNotFound, err}
	}
	if errors.Is(err, store.ErrModelGuideRevisionNotFound) {
		return &statusError{http.StatusNotFound, err}
	}
	return err
}

func (s *Server) listModelGuides(ctx context.Context, ownerUserID string) (store.ModelGuideList, error) {
	guides, err := s.store.ListModelGuides(ctx, ownerUserID)
	if err != nil {
		return store.ModelGuideList{}, err
	}
	list := store.ModelGuideList{Guides: make([]store.ModelGuideSummary, 0, len(guides))}
	for _, guide := range guides {
		list.Guides = append(list.Guides, modelGuideSummary(guide))
	}
	return list, nil
}

func (s *Server) modelObservationPage(ctx context.Context, ownerUserID, guideID string, offset, limit int) (store.ModelObservationPage, error) {
	observations, total, err := s.store.ListModelObservations(ctx, store.ModelObservationFilter{
		OwnerUserID: ownerUserID, GuideID: guideID, Offset: offset, Limit: limit,
	})
	if err != nil {
		return store.ModelObservationPage{}, err
	}
	page := store.ModelObservationPage{Total: total, Offset: offset, Observations: observations}
	if offset+len(observations) < total {
		page.NextOffset = offset + len(observations)
	}
	return page, nil
}

func (s *Server) modelGuideDetail(ctx context.Context, ownerUserID, id string) (store.ModelGuideDetail, error) {
	guide, err := s.store.GetModelGuide(ctx, ownerUserID, id)
	if err != nil {
		return store.ModelGuideDetail{}, modelGuideNotFound(err)
	}
	facts, err := s.modelGuideFacts(ctx, ownerUserID, guide)
	if err != nil {
		return store.ModelGuideDetail{}, err
	}
	observations, err := s.modelObservationPage(ctx, ownerUserID, guide.ID, 0, defaultModelObservations)
	if err != nil {
		return store.ModelGuideDetail{}, err
	}
	revisions, err := s.store.ListModelGuideRevisions(ctx, ownerUserID, guide.ID)
	if err != nil {
		return store.ModelGuideDetail{}, err
	}
	return store.ModelGuideDetail{Guide: guide, Facts: facts, Observations: observations, Revisions: revisions}, nil
}

// modelGuideFacts reads what the server knows of the guide's models: the
// configured context window and worker group quota of each alias's provider,
// and worker usage from the usage statistics. Nothing is stored.
func (s *Server) modelGuideFacts(ctx context.Context, ownerUserID string, guide store.ModelGuide) (store.ModelGuideFacts, error) {
	facts := store.ModelGuideFacts{Providers: []store.ModelGuideProviderFacts{}}
	groups, err := s.store.ListWorkerGroups(ctx, ownerUserID)
	if err != nil {
		return facts, err
	}
	targets := make([]store.ModelUsageTarget, 0, len(guide.Aliases))
	for _, alias := range guide.Aliases {
		targets = append(targets, store.ModelUsageTarget{ProfileID: alias.ProviderID, Runtime: string(alias.Runtime), Model: alias.Model})
		if alias.ProviderID == "" {
			continue
		}
		item := store.ModelGuideProviderFacts{Alias: alias}
		profile, err := s.store.GetProfile(ctx, alias.ProviderID)
		switch {
		case err == nil && profile.OwnerUserID == ownerUserID:
			item.ProviderLabel = profile.Label
			item.ContextWindow = int(profile.ContextWindows[alias.Model])
		case err != nil && !errors.Is(err, store.ErrProfileNotFound):
			return facts, err
		}
		for _, group := range groups {
			for _, member := range group.Members {
				if member.ProviderID == alias.ProviderID && (alias.Runtime == "" || member.Runtime == alias.Runtime) &&
					strings.EqualFold(member.Model, alias.Model) {
					item.WorkerGroupID, item.WorkerGroupLabel, item.TokensPerMinute = group.ID, group.Label, int(member.TokensPerMinute)
				}
			}
		}
		facts.Providers = append(facts.Providers, item)
	}
	usage, err := s.store.ModelUsage(ctx, time.Now().UTC().AddDate(0, 0, -modelGuideUsageWindowDays), ownerUserID, targets)
	if err != nil {
		return facts, err
	}
	facts.Usage = store.ModelGuideUsageFacts{
		WindowDays: modelGuideUsageWindowDays, WorkerSessions: int(usage.WorkerSessions), Requests: int(usage.Requests),
	}
	if usage.TimedRequests > 0 {
		facts.Usage.AvgRequestMs = int(usage.RequestMs / usage.TimedRequests)
	}
	if usage.GenerationMs > 0 {
		facts.Usage.TokPerSec = float64(usage.ThroughputTokens) * 1000 / float64(usage.GenerationMs)
	}
	return facts, nil
}

// resolveModelGuide maps a provider's model id to the person's guide; with
// none it suggests the canonical id to create one under.
func (s *Server) resolveModelGuide(ctx context.Context, ownerUserID string, target store.ModelGuideAlias) (store.ModelGuideResolution, error) {
	target, err := normalizeModelGuideTarget(target)
	if err != nil {
		return store.ModelGuideResolution{}, err
	}
	guide, alias, found, err := s.store.ResolveModelGuide(ctx, ownerUserID, target)
	if err != nil {
		return store.ModelGuideResolution{}, err
	}
	if found {
		summary := modelGuideSummary(guide)
		return store.ModelGuideResolution{Guide: &summary, MatchedAlias: &alias, SuggestedID: guide.ID, SuggestedIDTaken: true}, nil
	}
	suggested := store.SuggestedModelGuideID(target.Model)
	_, err = s.store.GetModelGuide(ctx, ownerUserID, suggested)
	if err != nil && !errors.Is(err, store.ErrModelGuideNotFound) {
		return store.ModelGuideResolution{}, err
	}
	return store.ModelGuideResolution{SuggestedID: suggested, SuggestedIDTaken: err == nil}, nil
}

func normalizeModelGuideTarget(target store.ModelGuideAlias) (store.ModelGuideAlias, error) {
	target, err := store.NormalizeModelGuideAlias(target)
	if err != nil {
		return target, &statusError{http.StatusBadRequest, err}
	}
	return target, nil
}

func (s *Server) handleListModelGuides(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list, err := s.listModelGuides(ctx, owner)
	writeResult(w, list, err)
}

func (s *Server) handleResolveModelGuide(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	query := r.URL.Query()
	resolution, err := s.resolveModelGuide(ctx, owner, store.ModelGuideAlias{
		ProviderKind: query.Get("providerKind"), ProviderID: query.Get("providerId"),
		Runtime: store.NativeRuntimeID(query.Get("runtime")), Model: query.Get("model"),
	})
	writeResult(w, resolution, err)
}

// handleResolveModelGuides resolves many provider model ids in one read, for
// the pages that show which guide each model has.
func (s *Server) handleResolveModelGuides(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input store.ModelGuideResolveBatch
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if len(input.Targets) > maxModelGuideBatch {
		writeResult(w, nil, &statusError{http.StatusBadRequest, fmt.Errorf("resolve at most %d models at once", maxModelGuideBatch)})
		return
	}
	resolutions := make([]store.ModelGuideResolution, len(input.Targets))
	for index, target := range input.Targets {
		if resolutions[index], err = s.resolveModelGuide(ctx, owner, target); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	writeResult(w, store.ModelGuideResolveBatchResult{Resolutions: resolutions}, nil)
}

func (s *Server) handleGetModelGuide(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	detail, err := s.modelGuideDetail(ctx, owner, r.PathValue("id"))
	writeResult(w, detail, err)
}

func (s *Server) handleGetModelGuideRevision(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	revision, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || revision < 1 {
		writeResult(w, nil, &statusError{http.StatusBadRequest, errors.New("revision must be a positive integer")})
		return
	}
	result, err := s.store.GetModelGuideRevision(ctx, owner, r.PathValue("id"), revision)
	writeResult(w, result, modelGuideNotFound(err))
}

func (s *Server) handleListModelGuideObservations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner, err := modelGuideOwner(s, ctx, actorFromContext(ctx))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	guide, err := s.store.GetModelGuide(ctx, owner, r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, modelGuideNotFound(err))
		return
	}
	query := r.URL.Query()
	offset, _ := strconv.Atoi(query.Get("offset"))
	limit, err := strconv.Atoi(query.Get("limit"))
	if err != nil {
		limit = defaultModelObservations
	}
	page, err := s.modelObservationPage(ctx, owner, guide.ID, max(offset, 0), min(max(limit, 1), maxModelObservations))
	writeResult(w, page, err)
}
