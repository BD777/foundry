package assistant

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Personal Agent's server side (docs/personal-agent.md): who the
// assistant is, the limits it is held to, stopping and resuming it, and
// the person's answer to its proposals. The REST routes, its MCP tools and
// the channels (httpapi) call these; none of them reaches a model.

// notAssistantSource starts sessions that are not the person talking to
// the assistant, even in its workspace.
func notAssistantSource(source string) bool {
	return source == store.SessionSourceAgent || source == store.SessionSourceVerification || store.IsUtilitySessionSource(source)
}

// Conversation is the assistant a session is a conversation of:
// one its person started in their Personal Agent Workspace, not one a
// session started there (§5). Such a session's role is personal_agent.
func (s *Service) Conversation(ctx context.Context, session store.AgentSession) (store.PersonalAgent, bool) {
	if session.Role != "" && session.Role != store.AgentSessionRolePersonalAgent {
		return store.PersonalAgent{}, false
	}
	if session.ParentSessionID != "" || session.CreatedByUserID == "" || notAssistantSource(session.Source) {
		return store.PersonalAgent{}, false
	}
	agent, err := s.store.AssistantForWorkspace(ctx, session.WorkspaceID)
	if err != nil || agent.UserID != session.CreatedByUserID {
		return store.PersonalAgent{}, false
	}
	return agent, true
}

// SessionRole is the role a session acts in: its recorded one, or
// personal_agent for the person's conversations with their assistant.
func (s *Service) SessionRole(ctx context.Context, session store.AgentSession) string {
	if session.Role != "" {
		return session.Role
	}
	if _, ok := s.Conversation(ctx, session); ok {
		return store.AgentSessionRolePersonalAgent
	}
	return ""
}

// usage counts what the limits apply to, now.
func (s *Service) usage(ctx context.Context, agent store.PersonalAgent) (store.PersonalAgentUsage, error) {
	return s.store.PersonalAgentUsage(ctx, agent, personalagent.Windows(time.Now(), s.PersonLocation(ctx, agent)))
}

// limitRefusal is a reached limit as the assistant reads it.
// limitRefusal refuses past a §9 limit; its text links settingsURL.
func limitRefusal(err error, settingsURL string) error {
	var limit *personalagent.LimitError
	if errors.As(err, &limit) {
		limit.SettingsURL = settingsURL
	}
	return &personalagent.Refusal{Status: http.StatusTooManyRequests, Err: err}
}

// settingsURL is the assistant's settings as a full link: what
// the assistant passes on works in the web and in a Feishu chat alike.
func (s *Service) settingsURL(agent store.PersonalAgent) string {
	return s.WebURL(personalagent.AssistantSettingsPath(agent.ID))
}

// errStopped refuses what the assistant asks while the person has it
// stopped.
var errStopped = &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("the person pressed stop: you may not change anything or start work until they resume you. Tell them it is stopped and that they can say \"resume\"")}

// AdmitSession is what a new session owes the person's assistant
// (§8, §9): one it hands off is refused while it is stopped, past a limit
// or on a device the person keeps it off, and is then followed up as a
// task (delegating); a new conversation counts against the hourly turns.
// Other sessions pass.
func (s *Service) AdmitSession(ctx context.Context, input store.CreateAgentSessionInput) (agent store.PersonalAgent, delegating bool, err error) {
	if input.ParentSessionID == "" {
		return agent, false, s.AdmitTurn(ctx, store.AgentSession{
			WorkspaceID: input.WorkspaceID, CreatedByUserID: input.CreatedByUserID, Source: input.Source,
		})
	}
	parent, err := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID)
	if err != nil {
		return agent, false, nil
	}
	agent, ok := s.Conversation(ctx, parent)
	if !ok {
		return agent, false, nil
	}
	if agent.State == store.PersonalAgentStopped {
		return agent, true, errStopped
	}
	if workspace, err := s.store.GetWorkspace(ctx, input.WorkspaceID); err == nil && workspace.DeviceID != "" && workspace.ID != agent.WorkspaceID &&
		!personalagent.DeviceSettings(agent.Settings.Devices, workspace.DeviceID, agent.HomeDeviceID).AllowWork {
		return agent, true, &personalagent.Refusal{Status: http.StatusUnprocessableEntity, Err: errors.New("not allowed: the person keeps you from working on that project's computer; tell them, and that they can change it in your settings (" + s.settingsURL(agent) + ")")}
	}
	usage, err := s.usage(ctx, agent)
	if err != nil {
		return agent, true, err
	}
	if err := personalagent.CheckDelegate(agent.Settings.Limits, usage); err != nil {
		return agent, true, limitRefusal(err, s.settingsURL(agent))
	}
	return agent, true, nil
}

// RecordTask follows up a session the assistant started (§6).
func (s *Service) RecordTask(ctx context.Context, agent store.PersonalAgent, conversationID string, session store.AgentSession) {
	if session.ID == "" {
		return
	}
	task := store.PersonalAgentTask{
		UserID: agent.UserID, AssistantID: agent.ID, ConversationSessionID: conversationID, SessionID: session.ID,
		WorkspaceID: session.WorkspaceID, Title: session.Title, Status: taskStatusOf(session.Status),
		ReadOnly: session.Source == store.SessionSourceVerification,
	}
	if task.Status != store.PersonalAgentTaskRunning {
		task.EndedAt = sessionEndedAt(session)
	}
	if _, err := s.store.CreatePersonalAgentTask(ctx, task); err != nil {
		log.Printf("personal agent %s: record task for %s: %v", agent.UserID, session.ID, err)
	}
}

// taskStatusOf is a task's status from its session's.
func taskStatusOf(sessionStatus string) string {
	switch sessionStatus {
	case "completed":
		return store.PersonalAgentTaskDone
	case "failed":
		return store.PersonalAgentTaskFailed
	case "canceled":
		return store.PersonalAgentTaskCancelled
	default:
		return store.PersonalAgentTaskRunning
	}
}

// sessionEndedAt is when a session that ended did, as best known.
func sessionEndedAt(session store.AgentSession) string {
	return cmp.Or(session.CompletedAt, session.LastActivityAt, formatPATime(time.Now()))
}

// AdmitTurn refuses a turn of the person's assistant past the
// hourly limit (§9, against loops). session is the conversation, or the
// one about to start; anything else is admitted.
func (s *Service) AdmitTurn(ctx context.Context, session store.AgentSession) error {
	agent, ok := s.Conversation(ctx, session)
	if !ok {
		return nil
	}
	usage, err := s.usage(ctx, agent)
	if err != nil {
		return err
	}
	if err := personalagent.CheckTurn(agent.Settings.Limits, usage); err != nil {
		return limitRefusal(err, s.settingsURL(agent))
	}
	return nil
}

// RefreshTasks brings the assistant's unfinished tasks up to date
// with their sessions.
func (s *Service) RefreshTasks(ctx context.Context, agent store.PersonalAgent) {
	userID := agent.UserID
	tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.ID, []string{
		store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking,
	})
	if err != nil {
		log.Printf("personal agent %s: list tasks: %v", userID, err)
		return
	}
	for _, task := range tasks {
		if task.SessionID == "" {
			continue
		}
		session, err := s.store.GetAgentSessionSummary(ctx, task.SessionID)
		if errors.Is(err, store.ErrNotFound) {
			// Its session went with its workspace.
			session = store.AgentSession{Status: "canceled"}
		} else if err != nil {
			continue
		}
		status := taskStatusOf(session.Status)
		// A helper that ended with a question waits for the person's answer.
		asking := task.Status == store.PersonalAgentTaskAsking && session.Status == "completed"
		if status == store.PersonalAgentTaskRunning || status == task.Status || asking {
			continue
		}
		ended := sessionEndedAt(session)
		task.Status, task.EndedAt, task.LastEventAt = status, ended, ended
		if err := s.store.UpdatePersonalAgentTask(ctx, task); err != nil {
			log.Printf("personal agent %s: update task %s: %v", userID, task.ID, err)
		}
	}
}

// Stop is the stop switch (§8), run by the server without the
// model: the assistant is stopped, its pending proposals void, and every
// session it runs or handed work to is cancelled. It answers how many
// sessions it stopped. Only the person's own request reaches it. It stops
// this one assistant: the person's other assistants keep working.
func (s *Service) Stop(ctx context.Context, agent store.PersonalAgent) (int, error) {
	agent, err := s.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped)
	if err != nil {
		return 0, err
	}
	if err := s.ExpireProposals(ctx, agent, time.Time{}); err != nil {
		log.Printf("assistant %s: void proposals on stop: %v", agent.ID, err)
	}
	if e := s.store.CancelUndispatchedPersonalAgentOperations(ctx, agent.ID); e != nil {
		return 0, e
	}
	ids, err := s.store.PersonalAgentActiveSessions(ctx, agent)
	if err != nil {
		return 0, err
	}
	stopped := 0
	for _, id := range ids {
		if s.StopSession(ctx, id) {
			stopped++
		}
	}
	if all, e := s.store.ActivePersonalAgentRunControlsFor(ctx, agent.ID); e == nil {
		seen := map[string]bool{}
		for _, id := range ids {
			seen[id] = true
		}
		for _, control := range all {
			if seen[control.SessionID] || (control.State != "monitoring" && control.State != "stop_requested") {
				continue
			}
			if control, e = s.store.RequestPersonalAgentRunStop(ctx, agent.ID, control.ID, "assistant_stopped"); e == nil {
				s.ReconcileRunControl(ctx, control)
				if receipt, e := s.store.GetPersonalAgentRunControl(ctx, agent.ID, control.ID); e == nil && receipt.State == "stopped" {
					stopped++
				}
			}
		}
	}
	s.RefreshTasks(ctx, agent)
	// What the assistant handled is the person's now (§h).
	s.HandOverAll(ctx, agent, store.PendingHandedStopped)
	return stopped, nil
}

// The stop switch requests a stop of each exact input. Disconnected native
// processes are not declared canceled merely because their transport is gone.
func (s *Service) StopSession(ctx context.Context, sessionID string) bool {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil || !store.IsActiveSessionStatus(session.Status) {
		return false
	}
	c, err := s.ensureRunControl(ctx, session)
	if err != nil {
		return false
	}
	c, err = s.store.RequestPersonalAgentRunStop(ctx, c.AssistantID, c.ID, "assistant_stopped")
	if err != nil {
		return false
	}
	s.ReconcileRunControl(ctx, c)
	current, err := s.store.GetPersonalAgentRunControl(ctx, c.AssistantID, c.ID)
	return err == nil && current.State == "stopped"
}

// Resume turns the assistant back on (§8). Nothing it stopped
// restarts; it answers the tasks the stop cancelled, for the assistant to
// ask about.
func (s *Service) Resume(ctx context.Context, agent store.PersonalAgent) ([]store.PersonalAgentTask, error) {
	before, err := s.store.GetAssistant(ctx, agent.ID)
	if err != nil {
		return nil, err
	}
	if _, err := s.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentActive); err != nil {
		return nil, err
	}
	cancelled, err := s.store.ListPersonalAgentTasks(ctx, agent.ID, []string{store.PersonalAgentTaskCancelled})
	if err != nil {
		return nil, err
	}
	stopped := []store.PersonalAgentTask{}
	for _, task := range cancelled {
		if before.StoppedAt != "" && task.EndedAt >= before.StoppedAt {
			stopped = append(stopped, task)
		}
	}
	return stopped, nil
}

// errProposalNotFound hides other people's proposals.
var errProposalNotFound = &personalagent.Refusal{Status: http.StatusNotFound, Err: errors.New("proposal not found")}

// DecideProposal is the person's answer to a proposal (§4):
// accepting applies exactly what was proposed, once. Callers have checked
// that the person answered: their web login, or the Feishu user paired
// with their direct chat. Session tokens and device credentials never
// reach it. The proposal must belong to agent; a card in one assistant's
// chat cannot answer another assistant's proposal.
func (s *Service) DecideProposal(ctx context.Context, agent store.PersonalAgent, proposalID string, accept bool, via string) (store.PersonalAgentProposal, error) {
	if _, err := s.store.GetPersonalAgentProposal(ctx, agent.ID, proposalID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.PersonalAgentProposal{}, errProposalNotFound
		}
		return store.PersonalAgentProposal{}, err
	}
	if err := s.ExpireProposals(ctx, agent, time.Now()); err != nil {
		return store.PersonalAgentProposal{}, err
	}
	status := store.PersonalAgentProposalDeclined
	if accept {
		status = store.PersonalAgentProposalAccepted
	}
	proposal, err := s.store.SetPersonalAgentProposalStatus(ctx, agent.ID, proposalID, []string{store.PersonalAgentProposalPending}, status, via, "")
	switch {
	case errors.Is(err, store.ErrNotFound):
		return proposal, errProposalNotFound
	case errors.Is(err, store.ErrPersonalAgentProposalSettled):
		return proposal, &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	case err != nil:
		return proposal, err
	}
	s.channel.PersonalAgentProposalChanged(proposal)
	say := s.proposalNoticeSayer(ctx, agent)
	if !accept {
		s.tell(ctx, proposal.SessionID, say("declined", proposal.Summary))
		return proposal, nil
	}
	if proposal.Kind == store.PersonalAgentProposalConnectorWrite {
		s.tell(ctx, proposal.SessionID, say("connectorApproved", proposal.Summary))
		return proposal, nil
	}
	result, applyErr := s.applyProposal(ctx, proposal)
	final, outcome := store.PersonalAgentProposalApplied, store.PersonalAgentOutcomeApplied
	errText := ""
	if applyErr != nil {
		final, outcome, errText = store.PersonalAgentProposalFailed, store.PersonalAgentOutcomeFailed, applyErr.Error()
	}
	s.recordAction(ctx, store.PersonalAgentActionRecord{
		UserID: agent.UserID, AssistantID: agent.ID, SessionID: proposal.SessionID, Tool: proposal.Kind, ArgsSummary: proposal.Summary,
		WorkspaceID: cmp.Or(proposal.WorkspaceID, workspaceIDOf(result)), Decision: store.PersonalAgentAsk,
		Outcome: outcome, ProposalID: proposal.ID, ConfirmedVia: via, Error: errText,
	}, proposal.Spec)
	proposal, err = s.store.SetPersonalAgentProposalStatus(ctx, agent.ID, proposalID, []string{store.PersonalAgentProposalAccepted}, final, "", errText)
	if err != nil {
		return proposal, err
	}
	s.channel.PersonalAgentProposalChanged(proposal)
	if applyErr != nil {
		s.tell(ctx, proposal.SessionID, say("failed", proposal.Summary, errText))
	} else {
		answer, _ := encodeJSON(result)
		s.tell(ctx, proposal.SessionID, say("applied", proposal.Summary, answer))
	}
	return proposal, nil
}

// ProposalCreated and ProposalChanged expose the same card notifications the
// assistant's own write tools use to other server modules, such as connector
// risk confirmations.
func (s *Service) ProposalCreated(proposal store.PersonalAgentProposal) {
	s.channel.PersonalAgentProposalCreated(proposal)
}

func (s *Service) ProposalChanged(proposal store.PersonalAgentProposal) {
	s.channel.PersonalAgentProposalChanged(proposal)
}

// proposalNoticeTexts tell the assistant the person's answer, [Chinese,
// English]: its conversation shows them too.
var proposalNoticeTexts = map[string][2]string{
	"declined": {"本人没有同意：%s 不要做，除非本人再提起，也不要再问。",
		"The person declined: %s Do not do it, and do not ask again unless they bring it up."},
	"failed": {"本人同意了，但没做成：%s 错误：%s", "The person accepted, but it failed: %s Error: %s"},
	"applied": {"本人同意了，已经做好：%s\n%s\n接着做你刚才在做的事。",
		"The person accepted and it is done: %s\n%s\nCarry on with what you were doing."},
	"connectorApproved": {"本人同意了：%s 现在重复刚才那个完全相同的请求一次；只批准了这一次。",
		"The person accepted: %s Repeat that exact connector request once now; this approval covers one call."},
}

// proposalNoticeSayer renders proposalNoticeTexts in the person's language.
func (s *Service) proposalNoticeSayer(ctx context.Context, agent store.PersonalAgent) func(key string, args ...any) string {
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	return func(key string, args ...any) string {
		return fmt.Sprintf(proposalNoticeTexts[key][languageIndex(language)], args...)
	}
}

// ExpireProposals expires the person's pending proposals that
// expired by now, or every pending one when now is zero (the stop switch),
// and shows it on their cards.
func (s *Service) ExpireProposals(ctx context.Context, agent store.PersonalAgent, now time.Time) error {
	pending, err := s.store.ListPersonalAgentProposals(ctx, agent.ID, []string{store.PersonalAgentProposalPending})
	if err != nil {
		return err
	}
	cutoff := ""
	if !now.IsZero() {
		cutoff = formatPATime(now)
	}
	expired, err := s.store.ExpirePersonalAgentProposals(ctx, agent.ID, cutoff)
	if err != nil || expired == 0 {
		return err
	}
	for _, proposal := range pending {
		// As the store compares them.
		if cutoff == "" || proposal.ExpiresAt <= cutoff {
			proposal.Status = store.PersonalAgentProposalExpired
			s.channel.PersonalAgentProposalChanged(proposal)
		}
	}
	return nil
}

// tell sends the assistant session a server notice as its next
// input: steered into a running turn, else a new turn.
func (s *Service) tell(ctx context.Context, sessionID, text string) {
	if sessionID == "" {
		return
	}
	if _, err := s.sessions.Send(ctx, sessionID, store.SendAgentSessionInput{Prompt: personalagent.Notice(text)}, nil); err != nil {
		log.Printf("tell assistant session %s: %v", sessionID, err)
	}
}

// recordAction appends to the assistant's audit trail; a failure to
// record is logged, never hidden from the person by failing the action.
func (s *Service) recordAction(ctx context.Context, record store.PersonalAgentActionRecord, args []byte) store.PersonalAgentActionRecord {
	saved, err := s.store.RecordPersonalAgentAction(ctx, record, args)
	if err != nil {
		log.Printf("personal agent %s: audit %s: %v", record.UserID, record.Tool, err)
	}
	return saved
}

// SuggestedHome is the device the setup card offers: one of the
// person's that is online, else the first. A device whose system account
// other people's devices use is never offered (they would reach the
// assistant's files and sign-ins); the person may still pick it in the
// card. None when every device of theirs is shared.
func (s *Service) SuggestedHome(ctx context.Context, userID string) (string, error) {
	owned, err := store.AvailableOwnedDevices(ctx, s.store, userID)
	if err != nil || len(owned) == 0 {
		return "", err
	}
	shared := s.devices.SharedAccounts(ctx)
	devices := slices.DeleteFunc(owned, func(deviceID string) bool { return len(shared[deviceID]) > 0 })
	if len(devices) == 0 {
		return "", nil
	}
	slices.Sort(devices)
	for _, deviceID := range devices {
		if s.devices.Connected(deviceID) {
			return deviceID, nil
		}
	}
	return devices[0], nil
}

// Setup gives the person their assistant on one of their
// devices (§2): its folder ~/Foundry/personal-agent with its AGENTS.md,
// registered as the Personal Agent Workspace, with the default settings;
// then every project the person can read gets its digest (§14).
//
// browserLanguage is the language of the browser that asked: an account
// following its browser's language has no language of its own, and what the
// server says itself (replies, cards, proposals, the folder's name) follows
// the assistant's language setting, which starts as this. browserTimezone
// is that browser's time zone, the time zone setting's first value.
func (s *Service) Setup(ctx context.Context, account *store.User, deviceID, browserLanguage, browserTimezone string) (store.PersonalAgent, error) {
	if _, err := s.store.GetPersonalAgent(ctx, account.ID); err == nil {
		return store.PersonalAgent{}, &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrPersonalAgentExists}
	}
	return s.create(ctx, account, "", deviceID, browserLanguage, browserTimezone, true)
}

// Create gives the person one more assistant (DEV-191), set up as Setup
// does with its own home workspace on deviceID. It is not the default, and
// its permission package reaches no workspace until the person adds them.
// The first assistant a person creates this way becomes their default.
func (s *Service) Create(ctx context.Context, account *store.User, name, deviceID, browserLanguage, browserTimezone string) (store.PersonalAgent, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return store.PersonalAgent{}, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("an assistant needs a name")}
	}
	_, err := s.store.DefaultAssistant(ctx, account.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.PersonalAgent{}, err
	}
	return s.create(ctx, account, name, deviceID, browserLanguage, browserTimezone, errors.Is(err, store.ErrNotFound))
}

func (s *Service) create(ctx context.Context, account *store.User, name, deviceID, browserLanguage, browserTimezone string, isDefault bool) (store.PersonalAgent, error) {
	owned, err := store.AvailableOwnedDevices(ctx, s.store, account.ID)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	if !slices.Contains(owned, deviceID) {
		return store.PersonalAgent{}, &personalagent.Refusal{Status: http.StatusNotFound, Err: errors.New("device not found")}
	}
	settings := personalagent.DefaultSettings()
	if account.Locale == "" {
		settings.Language = browserLanguage
	}
	settings.Timezone = personalagent.ValidTimezone(browserTimezone)
	if settings, err = personalagent.NormalizeSettings(settings, owned, deviceID); err != nil {
		return store.PersonalAgent{}, err
	}
	folderName := assistantFolderName(settings, account.Locale)
	if name != "" {
		folderName = name
		settings.AssistantName = name
	}
	workspace, err := s.createFolder(ctx, account.ID, deviceID, folderName, nil)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	agent, err := s.store.CreatePersonalAgent(ctx, store.PersonalAgent{
		Name: name, IsDefault: isDefault,
		UserID: account.ID, WorkspaceID: workspace.ID, HomeDeviceID: deviceID, State: store.PersonalAgentActive,
		Settings: settings, PromptVersion: prompt.Version,
	})
	if errors.Is(err, store.ErrPersonalAgentExists) {
		s.retireWorkspace(ctx, workspace)
		return agent, &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	}
	if err == nil {
		s.digests.Prime(account.ID)
	}
	return agent, err
}

// Delete removes one of the person's assistants that is not their default
// (DEV-191): it is stopped first (its sessions and helpers cancelled), its
// own records go (store.DeleteAssistant), the person's "needs you" items
// it handled return to the person, and its home workspace is archived with
// its conversations, not deleted.
func (s *Service) Delete(ctx context.Context, agent store.PersonalAgent) error {
	if agent.IsDefault {
		return &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrAssistantIsDefault}
	}
	if _, err := s.Stop(ctx, agent); err != nil {
		return err
	}
	if err := s.store.DeleteAssistant(ctx, agent.ID); err != nil {
		if errors.Is(err, store.ErrAssistantIsDefault) {
			return &personalagent.Refusal{Status: http.StatusConflict, Err: err}
		}
		return err
	}
	if workspace, err := s.store.GetWorkspace(ctx, agent.WorkspaceID); err == nil {
		s.retireWorkspace(ctx, workspace)
	}
	return nil
}

// assistantFolderName is the display name of the assistant's workspace.
func assistantFolderName(settings store.PersonalAgentSettings, AccountLocale string) string {
	if personalagent.LanguageOf(settings, AccountLocale) == "en" {
		return personalagent.DefaultNameEN
	}
	return personalagent.DefaultNameZH
}

// createFolder creates and registers the assistant's folder on
// the device: AGENTS.md (§2) and the files carried over from its previous
// home, in the first free of personal-agent, personal-agent-2, … under the
// device's first managed root.
func (s *Service) createFolder(ctx context.Context, userID, deviceID, name string, carried []personalagent.WorkspaceFile) (store.WorkspaceProjection, error) {
	folder, err := s.freeFolder(ctx, deviceID)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	files := append([]personalagent.WorkspaceFile{{Path: "AGENTS.md", Content: personalagent.AgentsFile()}}, carried...)
	return s.workspaces.CreateWorkspace(ctx, personalagent.WorkspaceActor{UserID: userID}, personalagent.NewWorkspace{
		DeviceID:   deviceID,
		Create:     &personalagent.WorkspaceSource{Kind: personalagent.WorkspaceCreateEmpty, GitInit: false, Files: files},
		FolderName: folder,
		Name:       name,
		Kind:       store.WorkspaceKindPersonalAgent,
	})
}

// freeFolder is a folder name for the assistant no workspace on
// the device has: the assistant may come back to a computer it left.
func (s *Service) freeFolder(ctx context.Context, deviceID string) (string, error) {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return "", err
	}
	taken := map[string]bool{}
	for _, workspace := range workspaces {
		if workspace.DeviceID == deviceID {
			taken[strings.ToLower(store.LastDevicePathElement(workspace.LocalPath))] = true
		}
	}
	// And the folders already there that are no workspace, such as one a
	// person removed from Foundry: the device refuses to create over them.
	for _, name := range s.devices.ManagedRootFolders(ctx, deviceID) {
		taken[strings.ToLower(name)] = true
	}
	folder := personalagent.HomeFolderName
	for n := 2; taken[folder]; n++ {
		folder = fmt.Sprintf("%s-%d", personalagent.HomeFolderName, n)
	}
	return folder, nil
}

// Overview answers GET /api/personal-agent: the person's default
// assistant, or the device setup would suggest before they have one.
func (s *Service) Overview(ctx context.Context, userID string) (store.PersonalAgentOverview, error) {
	agent, err := s.store.GetPersonalAgent(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		suggested, err := s.SuggestedHome(ctx, userID)
		return store.PersonalAgentOverview{SuggestedHomeDeviceID: suggested}, err
	}
	if err != nil {
		return store.PersonalAgentOverview{}, err
	}
	return s.OverviewOf(ctx, agent)
}

// OverviewOf answers GET /api/assistants/{id}.
func (s *Service) OverviewOf(ctx context.Context, agent store.PersonalAgent) (store.PersonalAgentOverview, error) {
	usage, err := s.usage(ctx, agent)
	if err != nil {
		return store.PersonalAgentOverview{}, err
	}
	return store.PersonalAgentOverview{Agent: &agent, HomeDeviceOnline: s.devices.Connected(agent.HomeDeviceID), Usage: &usage}, nil
}

// SaveSettings checks and stores what the panel saved.
func (s *Service) SaveSettings(ctx context.Context, agent store.PersonalAgent, settings store.PersonalAgentSettings) (store.PersonalAgent, error) {
	userID := agent.UserID
	owned, err := s.store.DevicesOwnedBy(ctx, userID)
	if err != nil {
		return agent, err
	}
	normalized, err := personalagent.NormalizeSettings(settings, owned, agent.HomeDeviceID)
	if err != nil {
		return agent, &personalagent.Refusal{Status: http.StatusBadRequest, Err: err}
	}
	available, err := store.AvailableOwnedDevices(ctx, s.store, userID)
	if err != nil {
		return agent, err
	}
	for i := range normalized.Devices {
		entry := &normalized.Devices[i]
		if !slices.Contains(available, entry.DeviceID) && !slices.ContainsFunc(settings.Devices, func(sent store.PersonalAgentDeviceSettings) bool { return sent.DeviceID == entry.DeviceID }) {
			entry.AllowWork, entry.AllowCreate = false, false
		}
	}
	saved, err := s.store.SavePersonalAgentSettings(ctx, agent.ID, normalized)
	var inUse *store.PersonalAgentFeishuAppInUse
	if errors.As(err, &inUse) {
		return agent, &personalagent.Refusal{Status: http.StatusConflict, Err: err}
	}
	return saved, err
}

// ErrNoAssistant answers the person who has not set one up.
var ErrNoAssistant = &personalagent.Refusal{Status: http.StatusNotFound, Err: fmt.Errorf("no assistant yet: set it up first")}

// AccountLocale is the language the person's account is set to, "" to
// follow their browser.
func (s *Service) AccountLocale(ctx context.Context, userID string) string {
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		return ""
	}
	return user.Locale
}

// PersonLocation is the time zone of the assistant's person
// (personalagent.Location).
func (s *Service) PersonLocation(ctx context.Context, agent store.PersonalAgent) *time.Location {
	return personalagent.Location(agent.Settings, s.AccountLocale(ctx, agent.UserID))
}
