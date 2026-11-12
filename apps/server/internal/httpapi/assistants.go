package httpapi

import (
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A person's assistants (DEV-191): /api/assistants lists, creates, renames
// and deletes them; each one's own routes are /api/assistants/{assistant}/…
// (assistantRoutes), the same handlers as the /api/personal-agent alias.

func assistantSummary(agent store.PersonalAgent) store.AssistantSummary {
	return store.AssistantSummary{
		ID: agent.ID, Name: agent.Name, IsDefault: agent.IsDefault, WorkspaceID: agent.WorkspaceID,
		HomeDeviceID: agent.HomeDeviceID, State: agent.State, PermissionPackageID: agent.PermissionPackageID,
		FeishuAppID: agent.Settings.FeishuAppID, CreatedAt: agent.CreatedAt, UpdatedAt: agent.UpdatedAt,
	}
}

func (s *Server) handleListAssistants(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListAssistants(r.Context(), s.personFrom(r).ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list := store.AssistantList{Assistants: make(jsonempty.List[store.AssistantSummary], 0, len(agents))}
	for _, agent := range agents {
		list.Assistants = append(list.Assistants, assistantSummary(agent))
	}
	writeResult(w, list, nil)
}

func (s *Server) handleCreateAssistant(w http.ResponseWriter, r *http.Request) {
	var input store.CreateAssistantInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, err := s.assistant.Create(r.Context(), s.personFrom(r), input.Name, strings.TrimSpace(input.HomeDeviceID), requestLanguage(r), "")
	writeResultWithStatus(w, http.StatusCreated, agent, err)
}

func (s *Server) handleUpdateAssistant(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.UpdateAssistantInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if name := strings.TrimSpace(input.Name); name != "" {
		var err error
		if agent, err = s.store.RenameAssistant(r.Context(), agent.ID, name); err != nil {
			writeResult(w, nil, err)
			return
		}
	}
	writeResult(w, agent, nil)
}

// handleDeleteAssistant deletes a non-default assistant (assistant.Delete
// says what happens to its records and workspace); the default one is a
// conflict.
func (s *Server) handleDeleteAssistant(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.assistant.Delete(r.Context(), agent); err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
