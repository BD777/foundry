package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The web's /api/personal-agent routes (docs/personal-agent.md §8, §11):
// the person's own assistant, its settings, memory, proposals, tasks,
// activity and the stop switch. Every route is personOnly: only the
// signed-in person, never a session token or a device credential, reads or
// changes them.

func (s *Server) personFrom(r *http.Request) *store.User {
	return actorFromContext(r.Context()).Account
}

// personalAgentOf is the caller's assistant; 404 before setup.
func (s *Server) personalAgentOf(w http.ResponseWriter, r *http.Request) (store.PersonalAgent, bool) {
	agent, err := s.store.GetPersonalAgent(r.Context(), s.personFrom(r).ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			err = assistant.ErrNoAssistant
		}
		writeResult(w, nil, err)
		return agent, false
	}
	return agent, true
}

func (s *Server) handlePersonalAgentOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.assistant.Overview(r.Context(), s.personFrom(r).ID)
	writeResult(w, overview, err)
}

func (s *Server) handleSetupPersonalAgent(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentSetupInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, err := s.assistant.Setup(r.Context(), s.personFrom(r), strings.TrimSpace(input.DeviceID), requestLanguage(r), input.Timezone)
	writeResultWithStatus(w, http.StatusCreated, agent, err)
}

// handleFillPersonalAgentTimezone is the web giving the browser's time zone
// to an assistant that has none; one already set stays.
func (s *Server) handleFillPersonalAgentTimezone(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentTimezoneInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	zone := personalagent.ValidTimezone(input.Timezone)
	if zone == "" {
		writeError(w, http.StatusBadRequest, "timezone must be an IANA time zone such as Asia/Shanghai")
		return
	}
	if agent.Settings.Timezone != "" {
		writeResult(w, agent, nil)
		return
	}
	agent, err := s.store.FillPersonalAgentTimezone(r.Context(), agent.UserID, zone)
	writeResult(w, agent, err)
}

func (s *Server) handleSavePersonalAgentSettings(w http.ResponseWriter, r *http.Request) {
	var settings store.PersonalAgentSettings
	if !decodeJSONRequest(w, r, &settings) {
		return
	}
	agent, err := s.assistant.SaveSettings(r.Context(), s.personFrom(r).ID, settings)
	if errors.Is(err, store.ErrNotFound) {
		err = assistant.ErrNoAssistant
	}
	writeResult(w, agent, err)
}

// personalAgentSwitch answers the stop switch and resuming with the fixed
// reply the channels also send.
type personalAgentSwitch struct {
	Agent   store.PersonalAgent       `json:"agent"`
	Stopped int                       `json:"stopped,omitempty"`
	Tasks   []store.PersonalAgentTask `json:"tasks,omitempty"`
	Reply   string                    `json:"reply"`
}

func (s *Server) handleStopPersonalAgent(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	stopped, err := s.assistant.Stop(r.Context(), agent.UserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	agent, err = s.store.GetPersonalAgent(r.Context(), agent.UserID)
	language := personalagent.LanguageOf(agent.Settings, s.personFrom(r).Locale)
	writeResult(w, personalAgentSwitch{Agent: agent, Stopped: stopped, Reply: personalagent.StopReply(language, stopped)}, err)
}

func (s *Server) handleResumePersonalAgent(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	tasks, err := s.assistant.Resume(r.Context(), agent.UserID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	agent, err = s.store.GetPersonalAgent(r.Context(), agent.UserID)
	language := personalagent.LanguageOf(agent.Settings, s.personFrom(r).Locale)
	stopped := make([]string, 0, len(tasks))
	for _, task := range tasks {
		stopped = append(stopped, task.Title)
	}
	writeResult(w, personalAgentSwitch{Agent: agent, Tasks: tasks, Reply: personalagent.ResumeReply(language, stopped)}, err)
}

func (s *Server) handleListPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.personalAgentOf(w, r); !ok {
		return
	}
	items, err := s.store.ListPersonalAgentMemory(r.Context(), s.personFrom(r).ID)
	writeResult(w, items, err)
}

// handleAddPersonalAgentMemory is the person writing a fact in the panel:
// theirs, active at once.
func (s *Server) handleAddPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if _, e := s.knowledge.PrimaryVault(r.Context(), agent.UserID); e == nil {
		writeResult(w, nil, invalid("a Memory Workspace is selected; add new facts to that source"))
		return
	} else if !errors.Is(e, store.ErrNotFound) {
		writeResult(w, nil, e)
		return
	}
	var input store.PersonalAgentMemoryInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	content, err := personalagent.MemoryContent(input.Content)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.store.AddPersonalAgentMemory(r.Context(), store.PersonalAgentMemoryItem{
		UserID: agent.UserID, Content: content, Origin: store.PersonalAgentMemoryEdited, Status: store.PersonalAgentMemoryActive,
	})
	writeResultWithStatus(w, http.StatusCreated, item, err)
}

// handleEditPersonalAgentMemory replaces an item with the person's wording;
// the old one is kept as superseded until forgotten.
func (s *Server) handleEditPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentMemoryInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	content, err := personalagent.MemoryContent(input.Content)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.store.SupersedePersonalAgentMemory(r.Context(), agent.UserID, r.PathValue("id"), store.PersonalAgentMemoryItem{
		Content: content, Origin: store.PersonalAgentMemoryEdited, Status: store.PersonalAgentMemoryActive,
	})
	writeResult(w, item, err)
}

// handleConfirmPersonalAgentMemory makes a pending suggestion or a guess
// the person's.
func (s *Server) handleConfirmPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	item, err := s.store.ConfirmPersonalAgentMemory(r.Context(), agent.UserID, r.PathValue("id"))
	writeResult(w, item, err)
}

func (s *Server) handleForgetPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.store.ForgetPersonalAgentMemory(r.Context(), agent.UserID, r.PathValue("id")); err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleForgetAllPersonalAgentMemory(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	forgotten, err := s.store.ForgetAllPersonalAgentMemory(r.Context(), agent.UserID)
	writeResult(w, map[string]int{"forgotten": forgotten}, err)
}

func (s *Server) handleListPersonalAgentProposals(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.assistant.ExpireProposals(r.Context(), agent.UserID, time.Now()); err != nil {
		writeResult(w, nil, err)
		return
	}
	proposals, err := s.store.ListPersonalAgentProposals(r.Context(), agent.UserID, r.URL.Query()["status"])
	writeResult(w, proposals, err)
}

func (s *Server) handleAcceptPersonalAgentProposal(w http.ResponseWriter, r *http.Request) {
	s.answerPersonalAgentProposal(w, r, true)
}

func (s *Server) handleDeclinePersonalAgentProposal(w http.ResponseWriter, r *http.Request) {
	s.answerPersonalAgentProposal(w, r, false)
}

func (s *Server) answerPersonalAgentProposal(w http.ResponseWriter, r *http.Request, accept bool) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	proposal, err := s.assistant.DecideProposal(r.Context(), agent.UserID, r.PathValue("id"), accept, store.PersonalAgentViaWeb)
	writeResult(w, proposal, err)
}

func (s *Server) handleListPersonalAgentTasks(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	s.assistant.RefreshTasks(r.Context(), agent.UserID)
	tasks, err := s.store.ListPersonalAgentTasks(r.Context(), agent.UserID, r.URL.Query()["status"])
	writeResult(w, s.assistant.WithTaskWaits(r.Context(), tasks), err)
}

// handleStopPersonalAgentTask stops one piece of work the assistant
// handed off ("正在做的事", each stoppable on its own).
func (s *Server) handleStopPersonalAgentTask(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	tasks, err := s.store.ListPersonalAgentTasks(r.Context(), agent.UserID, nil)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, task := range tasks {
		if task.ID != r.PathValue("id") {
			continue
		}
		if task.SessionID == "" || !s.assistant.StopSession(r.Context(), task.SessionID) {
			writeError(w, http.StatusConflict, "this work is not running")
			return
		}
		s.assistant.RefreshTasks(r.Context(), agent.UserID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeError(w, http.StatusNotFound, "task not found")
}

func (s *Server) handleListPersonalAgentActions(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	actions, err := s.store.ListPersonalAgentActions(r.Context(), agent.UserID, 0)
	writeResult(w, actions, err)
}

func (s *Server) handleMovePersonalAgentHome(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentSetupInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	agent, err := s.assistant.MoveHome(r.Context(), s.personFrom(r), strings.TrimSpace(input.DeviceID))
	writeResult(w, agent, err)
}

func (s *Server) handlePersonalAgentRunPreview(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentRunPreview
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	snapshot, err := s.runs.Resolve(r.Context(), agent, strings.TrimSpace(input.Role), strings.TrimSpace(input.WorkspaceID))
	writeResult(w, snapshot, err)
}

func (s *Server) handlePersonalAgentRunSnapshots(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListPersonalAgentRunSnapshots(r.Context(), s.personFrom(r).ID, 100)
	writeResult(w, items, err)
}

func (s *Server) handleCapturePersonalAgentInbox(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentInboxCapture
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	entry, err := s.assistant.CaptureInbox(r.Context(), s.personFrom(r).ID, "web", input)
	writeResultWithStatus(w, http.StatusAccepted, entry, err)
}

func (s *Server) handleListPersonalAgentInbox(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListPersonalAgentInbox(r.Context(), s.personFrom(r).ID, 200)
	writeResult(w, items, err)
}

func (s *Server) handlePersonalAgentInboxAction(w http.ResponseWriter, r *http.Request) {
	var input store.PersonalAgentInboxAction
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	entry, err := s.assistant.RetryInbox(r.Context(), s.personFrom(r).ID, r.PathValue("id"), input)
	writeResultWithStatus(w, http.StatusAccepted, entry, err)
}

func (s *Server) handlePersonalAgentOperations(w http.ResponseWriter, r *http.Request) {
	ops, err := s.store.ListPersonalAgentOperations(r.Context(), s.personFrom(r).ID)
	writeResult(w, ops, err)
}

func (s *Server) handleCancelPendingDispatch(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64 `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	op, e := s.store.CancelPendingPersonalAgentOperation(r.Context(), s.personFrom(r).ID, r.PathValue("operation"), input.Revision)
	if e != nil {
		e = &statusError{http.StatusConflict, e}
	}
	writeResult(w, op, e)
}

func (s *Server) handleMaintenanceList(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.store.ListPersonalAgentMaintenance(r.Context(), s.personFrom(r).ID)
	writeResult(w, jobs, err)
}

func (s *Server) handleMaintenanceAction(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.GetPersonalAgentMaintenance(r.Context(), s.personFrom(r).ID, r.PathValue("job"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		Action   string `json:"action"`
		Revision int64  `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	saved, err := s.assistant.MaintenanceAction(r.Context(), job, input.Action, input.Revision)
	writeResult(w, saved, err)
}

func (s *Server) handleContextPatches(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.ListPersonalAgentContextPatches(r.Context(), s.personFrom(r).ID)
	writeResult(w, v, err)
}

func (s *Server) handleContextPatch(w http.ResponseWriter, r *http.Request) {
	job, err := s.store.GetPersonalAgentMaintenance(r.Context(), s.personFrom(r).ID, r.PathValue("job"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input assistant.ContextPatchRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	answer, accepted, err := s.assistant.ContextPatch(r.Context(), job, input)
	if accepted {
		writeResultWithStatus(w, http.StatusAccepted, answer, err)
		return
	}
	writeResult(w, answer, err)
}

// handleListPersonalAgentItems answers the person's open items and those
// closed since ?closedSince (none without it).
func (s *Server) handleListPersonalAgentItems(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	since := ""
	if value := strings.TrimSpace(r.URL.Query().Get("closedSince")); value != "" {
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "closedSince must be an RFC 3339 time")
			return
		}
		since = at.UTC().Format(time.RFC3339Nano)
	}
	items, err := s.assistant.Items(r.Context(), agent.UserID, since)
	writeResult(w, items, err)
}

// handleEditPersonalAgentItem is the person's own edit (assistant.EditItem).
func (s *Server) handleEditPersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentListItemInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	saved, err := s.assistant.EditItem(r.Context(), agent, r.PathValue("id"), input)
	writeResult(w, saved, err)
}

func (s *Server) handleDeletePersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.store.DeletePersonalAgentItem(r.Context(), agent.UserID, r.PathValue("id")); err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAssistantRunControls(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.ListPersonalAgentRunControls(r.Context(), s.personFrom(r).ID)
	writeResult(w, rows, err)
}

func (s *Server) handleStopAssistantRun(w http.ResponseWriter, r *http.Request) {
	row, err := s.store.RequestPersonalAgentRunStop(r.Context(), s.personFrom(r).ID, r.PathValue("control"), "person_requested")
	writeResultWithStatus(w, http.StatusAccepted, row, err)
}
