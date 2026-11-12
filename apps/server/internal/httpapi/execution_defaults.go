package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type executionChoiceRequest struct {
	ID            string `json:"id"`
	ProviderKind  string `json:"providerKind"`
	ProviderID    string `json:"providerId"`
	Runtime       string `json:"runtime"`
	Model         string `json:"model"`
	WorkerGroupID string `json:"workerGroupId"`
	Effort        string `json:"effort"`
}

type executionDefaultRequest struct {
	ProviderKind  string                   `json:"providerKind"`
	ProviderID    string                   `json:"providerId"`
	Runtime       string                   `json:"runtime"`
	Model         string                   `json:"model"`
	WorkerGroupID string                   `json:"workerGroupId"`
	Effort        string                   `json:"effort"`
	Alternatives  []executionChoiceRequest `json:"alternatives"`
}

type executionDefaultsView struct {
	WorkspaceID string                       `json:"workspaceId,omitempty"`
	Saved       *store.ExecutionModelDefault `json:"saved,omitempty"`
	Effective   store.ExecutionModelDefault  `json:"effective"`
}

func noneExecutionDefault() store.ExecutionModelDefault {
	return store.ExecutionModelDefault{Alternatives: []store.ExecutionModelChoice{}, Scope: "none"}
}

func publicExecutionDefault(value store.StoredExecutionModelDefault) store.ExecutionModelDefault {
	alternatives := make([]store.ExecutionModelChoice, len(value.Alternatives))
	copy(alternatives, value.Alternatives)
	for index := range alternatives {
		alternatives[index].ID = personalagent.ExecutionChoiceID(alternatives[index])
	}
	public := store.ExecutionModelDefault{
		Alternatives: alternatives, Scope: value.Scope, UpdatedBy: value.UpdatedBy, UpdatedAt: value.UpdatedAt,
	}
	if value.WorkerGroupID != "" {
		// A group chooses provider, model and effort per worker.
		public.WorkerGroupID = value.WorkerGroupID
		return public
	}
	public.ProviderKind = store.ExecutionModelDefaultProviderKind(value.ProviderKind)
	public.ProviderID = value.ProviderID
	public.Runtime = store.NativeRuntimeID(value.Runtime)
	public.Model = value.Model
	public.Effort = value.Effort
	return public
}

func publicAssistantExecutionModels(value store.PersonalAgentExecutionModels) store.ExecutionModelDefault {
	alternatives := make([]store.ExecutionModelChoice, len(value.Alternatives))
	copy(alternatives, value.Alternatives)
	for index := range alternatives {
		alternatives[index].ID = personalagent.ExecutionChoiceID(alternatives[index])
	}
	return store.ExecutionModelDefault{
		ProviderKind: store.ExecutionModelDefaultProviderKind(value.ProviderKind),
		ProviderID:   value.ProviderID, Runtime: value.Runtime, Model: value.Model,
		WorkerGroupID: value.WorkerGroupID, Effort: value.Effort,
		Alternatives: alternatives, Scope: store.ExecutionDefaultScope("assistant"),
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
		if err := s.fillExecutionDefaultGroup(ctx, &public); err != nil {
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
		if err := s.fillExecutionDefaultGroup(ctx, &public); err != nil {
			return view, err
		}
		view.Saved, view.Effective = &public, public
	}
	return view, nil
}

func (s *Server) fillExecutionDefaultGroup(ctx context.Context, value *store.ExecutionModelDefault) error {
	group, err := s.fillExecutionChoiceGroup(ctx, value.WorkerGroupID)
	if err != nil {
		return err
	}
	value.Group = group
	for index := range value.Alternatives {
		group, err := s.fillExecutionChoiceGroup(ctx, value.Alternatives[index].WorkerGroupID)
		if err != nil {
			return err
		}
		value.Alternatives[index].Group = group
	}
	return nil
}

func (s *Server) fillExecutionChoiceGroup(ctx context.Context, workerGroupID string) (*store.WorkerGroup, error) {
	if workerGroupID == "" {
		return nil, nil
	}
	group, err := s.store.GetWorkerGroup(ctx, workerGroupID)
	if errors.Is(err, store.ErrWorkerGroupNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	public := publicWorkerGroup(group)
	return &public, nil
}

func (s *Server) validExecutionChoice(ctx context.Context, m providerManager, input executionChoiceRequest) (store.ExecutionModelChoice, error) {
	value := store.ExecutionModelChoice{
		ProviderKind:  store.ExecutionModelChoiceProviderKind(strings.TrimSpace(input.ProviderKind)),
		ProviderID:    strings.TrimSpace(input.ProviderID),
		Runtime:       store.NativeRuntimeID(strings.TrimSpace(input.Runtime)),
		Model:         strings.TrimSpace(input.Model),
		WorkerGroupID: strings.TrimSpace(input.WorkerGroupID),
		Effort:        strings.TrimSpace(input.Effort),
	}
	if value.ProviderID == "" && value.Runtime == "" && value.Model == "" && value.WorkerGroupID == "" && value.Effort == "" {
		return value, nil
	}
	if value.WorkerGroupID != "" {
		if value.ProviderID != "" || value.Runtime != "" || value.Model != "" || value.Effort != "" || value.ProviderKind != "" {
			return store.ExecutionModelChoice{}, &statusError{http.StatusBadRequest, errors.New("give a worker group or a provider with a model, not both: a group's members carry their own provider, model and effort")}
		}
		group, err := s.store.GetWorkerGroup(ctx, value.WorkerGroupID)
		if errors.Is(err, store.ErrWorkerGroupNotFound) || err == nil && group.OwnerUserID != m.userID {
			return store.ExecutionModelChoice{}, &statusError{http.StatusNotFound, store.ErrWorkerGroupNotFound}
		}
		return value, err
	}
	if value.ProviderID == "" || value.Model == "" {
		return store.ExecutionModelChoice{}, &statusError{http.StatusBadRequest, errors.New("providerId and model, or workerGroupId, are required")}
	}
	if value.Runtime != "claude" && value.Runtime != "codex" {
		return store.ExecutionModelChoice{}, &statusError{http.StatusBadRequest, errors.New("runtime must be claude or codex")}
	}
	if err := checkEffort(string(value.Runtime), value.Effort); err != nil {
		return store.ExecutionModelChoice{}, err
	}
	view, err := s.providerView(ctx, m)
	if err != nil {
		return store.ExecutionModelChoice{}, err
	}
	for _, provider := range view.providers() {
		if provider.ID == value.ProviderID && provider.Runtime == string(value.Runtime) &&
			(value.ProviderKind == "" || provider.Kind == string(value.ProviderKind)) {
			value.ProviderKind = store.ExecutionModelChoiceProviderKind(provider.Kind)
			return value, nil
		}
	}
	return store.ExecutionModelChoice{}, &statusError{http.StatusNotFound, errors.New("model provider not found: " + value.ProviderID)}
}

func executionChoiceRequestEmpty(input executionChoiceRequest) bool {
	return strings.TrimSpace(input.ProviderID) == "" &&
		strings.TrimSpace(input.Runtime) == "" &&
		strings.TrimSpace(input.Model) == "" &&
		strings.TrimSpace(input.WorkerGroupID) == "" &&
		strings.TrimSpace(input.Effort) == "" &&
		strings.TrimSpace(input.ProviderKind) == ""
}

func (s *Server) validExecutionDefault(ctx context.Context, m providerManager, input executionDefaultRequest, workspaceID string) (store.StoredExecutionModelDefault, error) {
	choice, err := s.validExecutionChoice(ctx, m, executionChoiceRequest{
		ProviderKind: input.ProviderKind, ProviderID: input.ProviderID, Runtime: input.Runtime,
		Model: input.Model, WorkerGroupID: input.WorkerGroupID, Effort: input.Effort,
	})
	if err != nil {
		return store.StoredExecutionModelDefault{}, err
	}
	value := store.StoredExecutionModelDefault{
		OwnerUserID: m.userID, WorkspaceID: workspaceID, ProviderKind: string(choice.ProviderKind),
		ProviderID: choice.ProviderID, Runtime: string(choice.Runtime), Model: choice.Model,
		WorkerGroupID: choice.WorkerGroupID, Effort: choice.Effort,
		Alternatives: make([]store.ExecutionModelChoice, 0, len(input.Alternatives)), UpdatedBy: m.userID,
	}
	for _, alternative := range input.Alternatives {
		if executionChoiceRequestEmpty(alternative) {
			return store.StoredExecutionModelDefault{}, &statusError{http.StatusBadRequest, errors.New("an execution alternative cannot be empty")}
		}
		validated, err := s.validExecutionChoice(ctx, m, alternative)
		if err != nil {
			return store.StoredExecutionModelDefault{}, err
		}
		value.Alternatives = append(value.Alternatives, validated)
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

func (s *Server) getExecutionDefaultForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	m, err := s.providerManagerFor(ctx, call.actor)
	if err != nil {
		return "", err
	}
	view, err := s.executionDefaults(ctx, m.userID, strings.TrimSpace(call.workspace))
	if err != nil {
		return "", err
	}
	if scope, scopeErr := s.paScope(ctx, call.actor); scopeErr == nil && scope.Agent.Settings.ExecutionModels != nil {
		effective := publicAssistantExecutionModels(*scope.Agent.Settings.ExecutionModels)
		if err := s.fillExecutionDefaultGroup(ctx, &effective); err != nil {
			return "", err
		}
		view.Saved, view.Effective = &effective, effective
	}
	return encodeJSON(view)
}
