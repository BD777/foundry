package httpapi

import (
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An assistant's memory layers (DEV-191 P2) as the web reaches them: the
// person's layer and the assistant's own, each entry with its scope, adding
// a fact to a layer and moving one to the other layer. Every route is the
// person's (personOnly / assistantOwner); file access is authorized by the
// knowledge service on use.

// errLegacyMemoryReadOnly answers a write to a legacy fact (pa_memory).
var errLegacyMemoryReadOnly = &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("legacy memory is read-only: its facts are copied to the person's memory layer; add or change facts in a layer (/memory/layers)")}

func (s *Server) handleMemoryLayers(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	answer := store.AssistantMemoryLayers{AssistantID: agent.ID, Layers: []store.MemoryLayer{}}
	for _, scope := range []string{store.MemoryScopePerson, store.MemoryScopeAssistant} {
		layer := store.MemoryLayer{Scope: store.MemoryLayerScope(scope), Entries: []store.MemoryLayerEntry{}}
		v, err := s.knowledge.MemoryLayer(r.Context(), agent, scope)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			writeResult(w, nil, err)
			return
		}
		if err == nil {
			layer.VaultID, layer.State, layer.Reason = v.ID, v.State, v.Reason
			layer.WorkspaceID, layer.DeviceID, layer.RootPath = v.WorkspaceID, v.DeviceID, v.RootPath
			entries, err := s.knowledge.Entries(r.Context(), v)
			if err != nil {
				layer.Reason = err.Error()
			}
			for _, entry := range entries {
				if entry.State != "active" {
					continue
				}
				layer.Entries = append(layer.Entries, store.MemoryLayerEntry{
					ID: entry.ID, VaultID: entry.VaultID, Scope: store.MemoryLayerScope(scope), Title: entry.Title, Revision: entry.Revision, Hash: entry.Hash,
					SourceRef: entry.SourceRef, ExpiresAt: entry.ExpiresAt, UpdatedAt: entry.UpdatedAt,
				})
			}
		}
		answer.Layers = append(answer.Layers, layer)
	}
	copies, err := s.store.LegacyMemoryCopies(r.Context(), agent.UserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	legacy, err := s.store.ListPersonalAgentMemory(r.Context(), agent.UserID)
	for _, item := range legacy {
		status := copies[item.ID]
		if item.Status == store.PersonalAgentMemoryActive && status != "copied" && status != "complete" {
			answer.LegacyUncopied++
		}
	}
	writeResult(w, answer, err)
}

// handleAddMemoryLayerEntry is the person writing a fact into a layer of
// the assistant's memory, created the first time.
func (s *Server) handleAddMemoryLayerEntry(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	scope := r.PathValue("scope")
	if !knowledge.ValidMemoryScope(scope) {
		writeError(w, http.StatusBadRequest, "scope must be person or assistant")
		return
	}
	var input store.AddMemoryEntryInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	v, err := s.knowledge.EnsureMemoryLayer(r.Context(), agent, scope)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	job, err := s.knowledge.Write(r.Context(), v, knowledge.WriteRequest{RequestID: input.RequestID, Title: input.Title, Body: input.Body, ExpiresAt: input.ExpiresAt})
	writeResultWithStatus(w, http.StatusAccepted, job, err)
}

// handleMoveMemoryEntry moves an entry of one layer of the assistant's
// memory to the other.
func (s *Server) handleMoveMemoryEntry(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.MoveMemoryEntryInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	move, err := s.knowledge.MoveEntry(r.Context(), agent, r.PathValue("entry"), knowledge.Move{ToScope: string(input.ToScope), ExpectedRevision: input.ExpectedRevision, ExpectedHash: input.ExpectedHash})
	writeResultWithStatus(w, http.StatusAccepted, move, err)
}

// handleMemorySorting is memory upkeep's sorting between layers as the
// person's settings show it: their recent automatic moves and the
// suggestions to share that still stand, across their assistants (the
// person's layer is every assistant's).
func (s *Server) handleMemorySorting(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	moves, suggestions, err := s.knowledge.SortRecords(r.Context(), agent.UserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	assistants, err := s.store.ListAssistants(r.Context(), agent.UserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	byID := map[string]store.PersonalAgent{}
	for _, a := range assistants {
		byID[a.ID] = a
	}
	answer := store.MemorySortList{Moves: []store.MemorySortRecord{}, Suggestions: []store.MemorySortRecord{}}
	for _, view := range moves {
		answer.Moves = append(answer.Moves, memorySortRecord(view, byID[view.AssistantID]))
	}
	for _, view := range suggestions {
		answer.Suggestions = append(answer.Suggestions, memorySortRecord(view, byID[view.AssistantID]))
	}
	writeResult(w, answer, nil)
}

func memorySortRecord(view knowledge.SortView, owner store.PersonalAgent) store.MemorySortRecord {
	return store.MemorySortRecord{
		ID: view.ID, Kind: store.MemorySortRecordKind(view.Kind), Status: view.Status,
		AssistantID: view.AssistantID, AssistantName: owner.Name, AssistantIsDefault: owner.IsDefault,
		FromScope: store.MemoryLayerScope(view.FromScope), ToScope: store.MemoryLayerScope(view.ToScope),
		Title: view.Title, Reason: view.Reason, Confidence: view.Confidence, Mentions: view.Mentions,
		Failure: view.Failure, Undoable: view.Undoable, CreatedAt: view.CreatedAt, UpdatedAt: view.UpdatedAt,
	}
}

// handleMemorySortAction is the person undoing an automatic move, or
// confirming or dismissing a suggestion to share.
func (s *Server) handleMemorySortAction(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.MemorySortActionInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	record, err := s.knowledge.SortAction(r.Context(), agent.UserID, r.PathValue("record"), string(input.Action))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	owner, _ := s.store.GetAssistant(r.Context(), record.AssistantID)
	writeResult(w, memorySortRecord(knowledge.SortView{MemorySort: record}, owner), nil)
}
