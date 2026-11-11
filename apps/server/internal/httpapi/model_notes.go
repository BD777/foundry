package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	defaultModelNotePage = 20
	maxModelNotePage     = 50
)

type modelNoteTarget struct {
	ProviderKind string `json:"providerKind"`
	ProviderID   string `json:"providerId"`
	Runtime      string `json:"runtime"`
	Model        string `json:"model"`
}

type modelNoteRequest struct {
	modelNoteTarget
	Body string `json:"body"`
}

type modelNotePage struct {
	Total      int               `json:"total"`
	Offset     int               `json:"offset"`
	NextOffset int               `json:"nextOffset,omitempty"`
	Notes      []store.ModelNote `json:"notes"`
}

func modelNoteQueryInt(r *http.Request, key string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return value
}

func (s *Server) modelNoteManager(ctx context.Context, actor Actor, target modelNoteTarget) (providerManager, error) {
	m, err := s.providerManagerFor(ctx, actor)
	if err != nil {
		return providerManager{}, err
	}
	if _, err := s.validModelNoteTarget(ctx, m, target); err != nil {
		return providerManager{}, err
	}
	return m, nil
}

func (s *Server) validModelNoteTarget(ctx context.Context, m providerManager, target modelNoteTarget) (mcpProvider, error) {
	target.ProviderKind = strings.TrimSpace(target.ProviderKind)
	target.ProviderID = strings.TrimSpace(target.ProviderID)
	target.Runtime = strings.TrimSpace(target.Runtime)
	target.Model = strings.TrimSpace(target.Model)
	if target.ProviderKind != providerKindSubscription && target.ProviderKind != providerKindAPI &&
		target.ProviderKind != providerKindEnvironment && target.ProviderKind != providerKindDiscovered {
		return mcpProvider{}, &statusError{http.StatusBadRequest, errors.New("providerKind must be subscription, api, environment or discovered")}
	}
	if target.ProviderID == "" || target.Model == "" {
		return mcpProvider{}, &statusError{http.StatusBadRequest, errors.New("providerId and model are required")}
	}
	if target.Runtime != "claude" && target.Runtime != "codex" {
		return mcpProvider{}, &statusError{http.StatusBadRequest, errors.New("runtime must be claude or codex")}
	}
	view, err := s.providerView(ctx, m)
	if err != nil {
		return mcpProvider{}, err
	}
	provider, ok := view.provider(target.ProviderKind, target.ProviderID)
	if !ok || provider.Runtime != target.Runtime {
		return mcpProvider{}, &statusError{http.StatusNotFound, errors.New("model provider not found: " + target.ProviderID)}
	}
	return provider, nil
}

func (s *Server) modelNoteAuthor(ctx context.Context, actor Actor, m providerManager) (store.User, string, error) {
	user, err := s.store.GetUser(ctx, m.userID)
	if err != nil {
		return store.User{}, "", err
	}
	sessionID := ""
	if actor.Agent() {
		sessionID = actor.Identity.SessionID
	}
	return user, sessionID, nil
}

func modelNoteFilter(owner string, target modelNoteTarget, offset, limit int) store.ModelNoteFilter {
	return store.ModelNoteFilter{
		OwnerUserID: owner, ProviderKind: strings.TrimSpace(target.ProviderKind),
		ProviderID: strings.TrimSpace(target.ProviderID), Runtime: strings.TrimSpace(target.Runtime),
		Model: strings.TrimSpace(target.Model), Offset: offset, Limit: limit,
	}
}

func (s *Server) modelNotesPage(ctx context.Context, owner string, target modelNoteTarget, offset, limit int) (modelNotePage, error) {
	stored, total, err := s.store.ListModelNotes(ctx, modelNoteFilter(owner, target, offset, limit))
	if err != nil {
		return modelNotePage{}, err
	}
	notes := make([]store.ModelNote, 0, len(stored))
	for _, note := range stored {
		notes = append(notes, publicModelNote(note))
	}
	page := modelNotePage{Total: total, Offset: offset, Notes: notes}
	if offset+len(notes) < total {
		page.NextOffset = offset + len(notes)
	}
	return page, nil
}

func publicModelNote(note store.StoredModelNote) store.ModelNote {
	return store.ModelNote{
		ID: note.ID, ProviderKind: note.ProviderKind, ProviderID: note.ProviderID,
		Runtime: store.NativeRuntimeID(note.Runtime), Model: note.Model, Body: note.Body,
		AuthorUserID: note.AuthorUserID, AuthorName: note.AuthorName,
		AuthorSessionID: note.AuthorSessionID, CreatedAt: note.CreatedAt, UpdatedAt: note.UpdatedAt,
	}
}

func (s *Server) handleListModelNotes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	target := modelNoteTarget{
		ProviderKind: r.URL.Query().Get("providerKind"), ProviderID: r.URL.Query().Get("providerId"),
		Runtime: r.URL.Query().Get("runtime"), Model: r.URL.Query().Get("model"),
	}
	m, err := s.modelNoteManager(ctx, actorFromContext(ctx), target)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	offset := max(modelNoteQueryInt(r, "offset", 0), 0)
	limit := min(max(modelNoteQueryInt(r, "limit", defaultModelNotePage), 1), maxModelNotePage)
	page, err := s.modelNotesPage(ctx, m.userID, target, offset, limit)
	writeResult(w, page, err)
}

func (s *Server) handleAppendModelNote(w http.ResponseWriter, r *http.Request) {
	var input modelNoteRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	actor := actorFromContext(ctx)
	m, err := s.modelNoteManager(ctx, actor, input.modelNoteTarget)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	user, sessionID, err := s.modelNoteAuthor(ctx, actor, m)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	note, err := s.store.AppendModelNote(ctx, store.StoredModelNote{
		OwnerUserID: m.userID, ProviderKind: strings.TrimSpace(input.ProviderKind),
		ProviderID: strings.TrimSpace(input.ProviderID), Runtime: strings.TrimSpace(input.Runtime),
		Model: strings.TrimSpace(input.Model), Body: input.Body,
		AuthorUserID: user.ID, AuthorName: user.DisplayName, AuthorSessionID: sessionID,
	})
	if err != nil {
		writeResultWithStatus(w, http.StatusCreated, nil, err)
		return
	}
	writeResultWithStatus(w, http.StatusCreated, publicModelNote(note), nil)
}

func (s *Server) ownedModelNote(ctx context.Context, actor Actor, id string) (store.StoredModelNote, providerManager, error) {
	m, err := s.providerManagerFor(ctx, actor)
	if err != nil {
		return store.StoredModelNote{}, providerManager{}, err
	}
	note, err := s.store.GetModelNote(ctx, id)
	if errors.Is(err, store.ErrModelNoteNotFound) || err == nil && note.OwnerUserID != m.userID {
		return store.StoredModelNote{}, providerManager{}, &statusError{http.StatusNotFound, errors.New("model note not found")}
	}
	return note, m, err
}

func (s *Server) handleUpdateModelNote(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Body string `json:"body"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	_, m, err := s.ownedModelNote(ctx, actorFromContext(ctx), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	note, err := s.store.UpdateModelNote(ctx, r.PathValue("id"), m.userID, input.Body)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, publicModelNote(note), nil)
}

func (s *Server) handleDeleteModelNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	_, m, err := s.ownedModelNote(ctx, actorFromContext(ctx), r.PathValue("id"))
	if err == nil {
		err = s.store.DeleteModelNote(ctx, r.PathValue("id"), m.userID)
	}
	if errors.Is(err, store.ErrModelNoteNotFound) {
		err = &statusError{http.StatusNotFound, errors.New("model note not found")}
	}
	writeResult(w, map[string]any{"deleted": r.PathValue("id")}, err)
}

type executionDefaultRequest struct {
	ProviderKind string `json:"providerKind"`
	ProviderID   string `json:"providerId"`
	Runtime      string `json:"runtime"`
	Model        string `json:"model"`
	ModelPoolID  string `json:"modelPoolId"`
	Effort       string `json:"effort"`
}

type executionDefaultsView struct {
	WorkspaceID string                       `json:"workspaceId,omitempty"`
	Saved       *store.ExecutionModelDefault `json:"saved,omitempty"`
	Effective   store.ExecutionModelDefault  `json:"effective"`
}

func noneExecutionDefault() store.ExecutionModelDefault {
	return store.ExecutionModelDefault{Scope: "none"}
}

func publicExecutionDefault(value store.StoredExecutionModelDefault) store.ExecutionModelDefault {
	return store.ExecutionModelDefault{
		ProviderKind: store.ExecutionModelDefaultProviderKind(value.ProviderKind),
		ProviderID:   value.ProviderID, Runtime: store.NativeRuntimeID(value.Runtime),
		Model: value.Model, ModelPoolID: value.ModelPoolID, Effort: value.Effort, Scope: value.Scope,
		UpdatedBy: value.UpdatedBy, UpdatedAt: value.UpdatedAt,
	}
}

func (s *Server) executionDefaults(ctx context.Context, ownerUserID, workspaceID string) (executionDefaultsView, error) {
	view := executionDefaultsView{WorkspaceID: workspaceID, Effective: noneExecutionDefault()}
	global, err := s.store.GetExecutionDefault(ctx, ownerUserID, "")
	if err != nil && !errors.Is(err, store.ErrExecutionDefaultNotFound) {
		return view, err
	}
	if err == nil {
		public := publicExecutionDefault(global)
		if err := s.fillExecutionDefaultPool(ctx, &public); err != nil {
			return view, err
		}
		view.Effective = public
		if workspaceID == "" {
			view.Saved = &public
		}
	}
	if workspaceID == "" {
		return view, nil
	}
	local, err := s.store.GetExecutionDefault(ctx, ownerUserID, workspaceID)
	if err != nil && !errors.Is(err, store.ErrExecutionDefaultNotFound) {
		return view, err
	}
	if err == nil {
		public := publicExecutionDefault(local)
		if err := s.fillExecutionDefaultPool(ctx, &public); err != nil {
			return view, err
		}
		view.Saved, view.Effective = &public, public
	}
	return view, nil
}

func (s *Server) fillExecutionDefaultPool(ctx context.Context, value *store.ExecutionModelDefault) error {
	if value.ModelPoolID == "" {
		return nil
	}
	pool, err := s.store.GetModelPool(ctx, value.ModelPoolID)
	if errors.Is(err, store.ErrModelPoolNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	public := publicModelPool(pool)
	value.Pool = &public
	return nil
}

func (s *Server) validExecutionDefault(ctx context.Context, m providerManager, input executionDefaultRequest, workspaceID string) (store.StoredExecutionModelDefault, error) {
	value := store.StoredExecutionModelDefault{
		OwnerUserID: m.userID, WorkspaceID: workspaceID, ProviderKind: strings.TrimSpace(input.ProviderKind),
		ProviderID: strings.TrimSpace(input.ProviderID), Runtime: strings.TrimSpace(input.Runtime),
		Model: strings.TrimSpace(input.Model), ModelPoolID: strings.TrimSpace(input.ModelPoolID),
		Effort: strings.TrimSpace(input.Effort), UpdatedBy: m.userID,
	}
	if value.ProviderID == "" && value.Runtime == "" && value.Model == "" && value.ModelPoolID == "" && value.Effort == "" {
		return value, nil
	}
	if value.ProviderID == "" || (value.Model == "" && value.ModelPoolID == "") {
		return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("providerId and model or modelPoolId are required")}
	}
	if value.Model != "" && value.ModelPoolID != "" {
		return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("give model or modelPoolId, not both")}
	}
	if value.Runtime != "claude" && value.Runtime != "codex" {
		return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("runtime must be claude or codex")}
	}
	if err := checkEffort(value.Runtime, value.Effort); err != nil {
		return store.StoredExecutionModelDefault{}, err
	}
	view, err := s.providerView(ctx, m)
	if err != nil {
		return store.StoredExecutionModelDefault{}, err
	}
	if value.ModelPoolID != "" {
		pool, err := s.store.GetModelPool(ctx, value.ModelPoolID)
		if errors.Is(err, store.ErrModelPoolNotFound) || err == nil && pool.OwnerUserID != m.userID {
			return store.StoredExecutionModelDefault{}, &statusError{http.StatusNotFound, store.ErrModelPoolNotFound}
		}
		if err != nil {
			return store.StoredExecutionModelDefault{}, err
		}
		if pool.ProviderID != value.ProviderID || pool.Runtime != value.Runtime {
			return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("model pool belongs to a different provider or runtime")}
		}
		if value.ProviderKind != "" && value.ProviderKind != pool.ProviderKind {
			return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("model pool belongs to a different provider kind")}
		}
		value.ProviderKind = pool.ProviderKind
	}
	found := false
	for _, provider := range view.providers() {
		if provider.ID == value.ProviderID && provider.Runtime == value.Runtime &&
			(value.ProviderKind == "" || provider.Kind == value.ProviderKind) {
			found = true
			value.ProviderKind = provider.Kind
			break
		}
	}
	if !found {
		return store.StoredExecutionModelDefault{}, &statusError{http.StatusNotFound, errors.New("model provider not found: " + value.ProviderID)}
	}
	return value, nil
}

func (s *Server) saveExecutionDefault(ctx context.Context, actor Actor, workspaceID string, input executionDefaultRequest) (executionDefaultsView, error) {
	m, err := s.providerManagerFor(ctx, actor)
	if err != nil {
		return executionDefaultsView{}, err
	}
	value, err := s.validExecutionDefault(ctx, m, input, workspaceID)
	if err != nil {
		return executionDefaultsView{}, err
	}
	if err := s.store.SetExecutionDefault(ctx, value); err != nil {
		return executionDefaultsView{}, err
	}
	return s.executionDefaults(ctx, m.userID, workspaceID)
}

func (s *Server) handleGetExecutionDefault(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err == nil {
		var view executionDefaultsView
		view, err = s.executionDefaults(r.Context(), m.userID, "")
		writeResult(w, view, err)
		return
	}
	writeResult(w, nil, err)
}

func (s *Server) handleSetExecutionDefault(w http.ResponseWriter, r *http.Request) {
	var input executionDefaultRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	view, err := s.saveExecutionDefault(r.Context(), actorFromContext(r.Context()), "", input)
	writeResult(w, view, err)
}

func (s *Server) handleGetWorkspaceExecutionDefault(w http.ResponseWriter, r *http.Request) {
	m, err := s.providerManagerFor(r.Context(), actorFromContext(r.Context()))
	if err == nil {
		var view executionDefaultsView
		view, err = s.executionDefaults(r.Context(), m.userID, strings.TrimSpace(r.PathValue("id")))
		writeResult(w, view, err)
		return
	}
	writeResult(w, nil, err)
}

func (s *Server) handleSetWorkspaceExecutionDefault(w http.ResponseWriter, r *http.Request) {
	var input executionDefaultRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	view, err := s.saveExecutionDefault(r.Context(), actorFromContext(r.Context()), strings.TrimSpace(r.PathValue("id")), input)
	writeResult(w, view, err)
}
