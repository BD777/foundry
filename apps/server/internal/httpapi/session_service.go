package httpapi

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

// Sessions start, take messages and stop through the session service
// (internal/sessions, over the ports in session_ports.go), whoever asks.
// What stays here is who may ask and where: a caller's new session
// (resolveNewSession), and the entry points integrations (Feishu) call.

// resolveNewSession applies, for REST (POST /api/agent-sessions) and MCP
// (create_session) alike, who may start input's session and where it runs,
// in this order:
//
//   - the session is its caller's person's; an agent's is created by its
//     parent's person (the store fills it in);
//   - an agent's session is its caller's child (Source "agent"), in the
//     caller's workspace unless it names another, inside the caller's Issue
//     (keepAgentInIssue), and names no native session by id, which could
//     fork one the caller cannot read;
//   - with runLikeParent, an agent's session naming no model runs on the
//     target workspace's execution default (startOnExecutionDefault), or,
//     when there is none or it cannot run there, on the workspace's account
//     default, and names that fact in its result; one naming only a model
//     keeps its parent's account; the assistant's helper takes its executor
//     default instead;
//   - a verifier's source is store.SessionSourceVerification;
//   - a fork runs in its source's workspace, on its agent (applySessionFork);
//   - the caller reaches that workspace as Member (workspaceRefusal); the
//     assistant reaches the workspaces its permission package allows
//     (assistant.Scope.CanStart);
//   - an agent adopts a native chat only of that workspace;
//   - with runLikeParent, a session naming no account runs under the one
//     its workspace and channel default to (chooseSessionAccount); without,
//     a person's request naming nothing is refused;
//   - the assistant's helper runs on its executor role's configured
//     default when it names no account (ApplyHelperDefaults);
//   - it runs on an agent of that workspace (sessions.Service.ResolveDevice).
//
// A refusal is a statusError. MCP passes runLikeParent; REST does not.
func (s *Server) resolveNewSession(ctx context.Context, actor Actor, input *store.CreateAgentSessionInput, runLikeParent bool) (start startResolution, err error) {
	// The assistant starts helpers through this same mechanism; its
	// admission parameters are its scope, executor default and the
	// conversation as report target and budget subject.
	assistantScope, assistantErr := s.paScope(ctx, actor)
	isAssistant := assistantErr == nil
	input.CreatedByUserID = actor.AccountID()
	// A model or account the caller named is used exactly as given.
	named := input.Provider != "" || input.ProfileID != "" || input.Model != "" || input.WorkerGroupID != "" || input.AgentID != ""
	if actor.Agent() {
		if strings.TrimSpace(input.NativeSessionID) != "" {
			return startResolution{}, &statusError{http.StatusBadRequest, errors.New("nativeSessionId is not accepted from a session: continue a Foundry session with its messages endpoint or fork it with forkSessionId")}
		}
		input.WorkspaceID = strings.TrimSpace(requestedWorkspace(actor, input.WorkspaceID))
		if err := s.keepAgentInIssue(ctx, actor, input); err != nil {
			return startResolution{}, &statusError{http.StatusForbidden, err}
		}
		input.ParentSessionID = actor.Identity.SessionID
		input.Source = store.SessionSourceAgent
	}
	if input.Verification {
		input.Source = store.SessionSourceVerification
	}
	if strings.TrimSpace(input.ForkSessionID) != "" {
		if err := s.applySessionFork(ctx, input, actor); err != nil {
			return startResolution{}, err
		}
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	if isAssistant {
		if err := assistantScope.StartRefusal(input.WorkspaceID); err != nil {
			return startResolution{}, err
		}
		// The input's id keys the run snapshot the helper's budget and
		// run control read, so it is settled before the budget is pinned.
		if input.InputID == "" {
			id, err := uuid.NewV7()
			if err != nil {
				return startResolution{}, &statusError{http.StatusInternalServerError, err}
			}
			input.InputID = id.String()
		}
		if _, err := s.assistant.ApplyHelperDefaults(ctx, input, nil); err != nil {
			return startResolution{}, err
		}
	} else {
		scope, err := s.contextScope(ctx, actor)
		if err != nil {
			return startResolution{}, err
		}
		if err := workspaceRefusal(scope, input.WorkspaceID, store.WorkspaceRoleMember); err != nil {
			return startResolution{}, err
		}
	}
	// A child that named no model runs on the target workspace's execution
	// default, as a person's work there does, not on its parent's profile:
	// elsewhere profiles belong to another device, where its own logins may
	// not be signed in. A fork keeps its source's agent (applySessionFork).
	// The caller's reach is checked first: choosing a default may take a
	// worker-group slot.
	if actor.Agent() && runLikeParent && !isAssistant && !named && strings.TrimSpace(input.ForkSessionID) == "" {
		// The person is the creator (the store fills it from the parent when
		// the agent's own input does not name one).
		models, err := s.runs.ResolveExecutionModels(ctx, s.sessionUserID(ctx, *input), nil, input.WorkspaceID)
		if err != nil {
			return startResolution{}, err
		}
		if start, err = s.startOnExecutionDefault(ctx, actor, input, models); err != nil {
			return startResolution{}, err
		}
	} else if actor.Agent() && runLikeParent && !isAssistant && strings.TrimSpace(input.ForkSessionID) == "" &&
		input.Model != "" && input.Provider == "" && input.ProfileID == "" && input.WorkerGroupID == "" && input.AgentID == "" {
		// A child that names only a model keeps today's rule: it runs where
		// its parent does, with the model it named.
		if parent, err := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID); err == nil && input.WorkspaceID == parent.WorkspaceID {
			input.Provider, input.ProfileID = parent.Provider, parent.ProfileID
		}
	}
	if input.WorkerGroupID != "" && named {
		if input.Model != "" || input.Provider != "" || input.ProfileID != "" || input.AgentID != "" {
			return startResolution{}, invalid("workerGroupId cannot be combined with model, provider, profileId or agentId: the group's member decides them")
		}
		var choice workerGroupChoice
		choice, err = s.selectWorkerGroup(ctx, actor, input.WorkerGroupID, input.WorkspaceID)
		if err != nil {
			return startResolution{}, err
		}
		member := choice.Member
		start.note = choice.Note
		input.WorkerGroupID, input.Provider, input.ProfileID, input.Model = choice.Group.ID, string(member.Runtime), member.ProviderID, member.Model
		if member.Effort != "" {
			if member.Runtime == "codex" {
				input.CodexReasoningEffort = member.Effort
			} else {
				input.ClaudeEffort = member.Effort
			}
		}
	}
	// A session adopts a native chat only from the workspace it starts in,
	// which it reaches as Member; an unassigned chat is in no workspace a
	// session reaches.
	if chatID := strings.TrimSpace(input.ChatID); chatID != "" && actor.Agent() {
		if chat, err := s.store.GetChat(ctx, chatID); err != nil || chat.WorkspaceID != input.WorkspaceID {
			return startResolution{}, &statusError{http.StatusNotFound, errors.New("chat not found")}
		}
	}
	if runLikeParent {
		if err := s.chooseSessionAccount(ctx, input); err != nil {
			return startResolution{}, err
		}
	}
	if err := s.sessionService.ResolveDevice(ctx, input); err != nil {
		return startResolution{}, err
	}
	if start.fallback != "" {
		// The account default is known only now; state what it resolved to.
		start.runsOn = fmt.Sprintf("runs on %s, the workspace's account default: %s", s.describeSessionModel(ctx, *input), start.fallback)
	}
	// A choice the caller named is used as given; the result only remarks on
	// it when it is outside the workspace's execution models.
	if runLikeParent && !isAssistant && named && strings.TrimSpace(input.ForkSessionID) == "" {
		models, err := s.runs.ResolveExecutionModels(ctx, s.sessionUserID(ctx, *input), nil, input.WorkspaceID)
		if err != nil {
			return startResolution{}, err
		}
		start.runsOn = s.namedChoiceFact(ctx, models, *input)
	}
	return start, nil
}

// startResolution is what resolving a new session adds beyond its record:
// note is recorded as a routing event when the session starts, and runsOn
// states, for create_session's result, the model it started on and why
// (facts only; "" when the caller's own choice needs no remark).
type startResolution struct {
	note     string
	runsOn   string
	fallback string
}

// startOnExecutionDefault starts a child that named no model on the target
// workspace's execution default, resolved as get_execution_default resolves
// it: a worker group (the group picks the member), or its provider, model
// and effort. A default that cannot run on the workspace's computer, and a
// workspace that set none, leave the account to chooseSessionAccount and
// say why.
func (s *Server) startOnExecutionDefault(ctx context.Context, actor Actor, input *store.CreateAgentSessionInput, models run.ExecutionModels) (startResolution, error) {
	if models.Scope == "" {
		return startResolution{fallback: "this workspace has no execution model set"}, nil
	}
	choice := models.Default
	if choice.WorkerGroupID != "" {
		selected, err := s.selectWorkerGroup(ctx, actor, choice.WorkerGroupID, input.WorkspaceID)
		if err != nil {
			// The person set this default, not this child: a group that
			// cannot run here falls back rather than refusing.
			return startResolution{fallback: "the execution default worker group " + s.describeChoice(ctx, choice) + " cannot run on this computer"}, nil
		}
		member := selected.Member
		input.WorkerGroupID = selected.Group.ID
		input.Provider, input.ProfileID, input.Model = string(member.Runtime), member.ProviderID, member.Model
		s.setSessionEffort(input, string(member.Runtime), member.Effort)
		return startResolution{
			note:   selected.Note,
			runsOn: fmt.Sprintf("runs on the workspace's execution default, worker group %q, which chose %s", cmp.Or(selected.Group.Label, selected.Group.ID), s.describeSessionModel(ctx, *input)),
		}, nil
	}
	workspace, err := s.store.GetWorkspace(ctx, input.WorkspaceID)
	if err != nil {
		return startResolution{}, err
	}
	if !s.accountUsable(ctx, workspace, choice.ProviderID) {
		return startResolution{fallback: "the execution default " + s.describeChoice(ctx, choice) + " cannot run on this computer"}, nil
	}
	input.Provider, input.ProfileID, input.Model = string(choice.Runtime), choice.ProviderID, choice.Model
	s.setSessionEffort(input, string(choice.Runtime), choice.Effort)
	return startResolution{runsOn: "runs on the workspace's execution default " + s.describeChoice(ctx, choice)}, nil
}

// namedChoiceFact states a caller's own choice when it is outside the
// workspace's execution models. Nothing is refused or changed: the person
// may have named it; the result just says so.
func (s *Server) namedChoiceFact(ctx context.Context, models run.ExecutionModels, input store.CreateAgentSessionInput) string {
	if models.Scope == "" || choiceIsListed(models, input) {
		return ""
	}
	listed := "default " + s.describeChoice(ctx, models.Default)
	if len(models.Alternatives) > 0 {
		alternatives := make([]string, len(models.Alternatives))
		for index, alternative := range models.Alternatives {
			alternatives[index] = s.describeChoice(ctx, alternative)
		}
		listed += "; alternatives: " + strings.Join(alternatives, ", ")
	}
	return fmt.Sprintf("runs on %s, which you named; it is not among this workspace's execution models (%s)", s.describeSessionModel(ctx, input), listed)
}

// choiceIsListed reports whether the choice an input names is one of models'
// default or alternatives. An input naming only an account (no model or
// group) cannot be told apart from its account's default model, so it counts
// as listed: the result stays quiet rather than claiming otherwise.
func choiceIsListed(models run.ExecutionModels, input store.CreateAgentSessionInput) bool {
	choices := append([]store.ExecutionModelChoice{models.Default}, models.Alternatives...)
	for _, choice := range choices {
		if input.WorkerGroupID != "" {
			if choice.WorkerGroupID == input.WorkerGroupID {
				return true
			}
			continue
		}
		if input.Model == "" {
			return true
		}
		if choice.WorkerGroupID != "" {
			// A group offers no single model to compare.
			continue
		}
		if choice.ProviderID == input.ProfileID && choice.Model == input.Model {
			return true
		}
	}
	return false
}

// describeSessionModel names what a session input runs on: its account and
// model, with its effort.
func (s *Server) describeSessionModel(ctx context.Context, input store.CreateAgentSessionInput) string {
	effort := input.ClaudeEffort
	if input.Provider == "codex" {
		effort = input.CodexReasoningEffort
	}
	return s.describeModel(ctx, input.ProfileID, input.Model, effort)
}

// describeChoice names an execution choice: its worker group, or its account
// and model.
func (s *Server) describeChoice(ctx context.Context, choice store.ExecutionModelChoice) string {
	if choice.WorkerGroupID != "" {
		label := choice.WorkerGroupID
		if group, err := s.store.GetWorkerGroup(ctx, choice.WorkerGroupID); err == nil {
			label = cmp.Or(group.Label, label)
		}
		return fmt.Sprintf("worker group %q", label)
	}
	return s.describeModel(ctx, choice.ProviderID, choice.Model, choice.Effort)
}

// describeModel names a model as people read it: the account's label and the
// model, with the effort when one is set.
func (s *Server) describeModel(ctx context.Context, profileID, model, effort string) string {
	name := model
	if profileID != "" {
		label := profileID
		if profile, err := s.store.GetProfile(ctx, profileID); err == nil {
			label = cmp.Or(profile.Label, label)
		}
		name = label
		if model != "" && model != label {
			name += "/" + model
		}
	}
	if name == "" {
		name = "its account's default model"
	}
	if effort != "" {
		name += " (" + effort + ")"
	}
	return name
}

// setSessionEffort pins an effort the input left for its runtime unset.
func (s *Server) setSessionEffort(input *store.CreateAgentSessionInput, runtime, effort string) {
	if effort == "" {
		return
	}
	if runtime == "codex" {
		input.CodexReasoningEffort = cmp.Or(input.CodexReasoningEffort, effort)
	} else {
		input.ClaudeEffort = cmp.Or(input.ClaudeEffort, effort)
	}
}

// applySessionFork resolves forkSessionId: a new Foundry session starts from
// a copy of the source's native history, on its agent and profile, so in its
// workspace; callers check the caller may start work there. Forking needs
// ordinary read visibility into the source.
func (s *Server) applySessionFork(ctx context.Context, input *store.CreateAgentSessionInput, actor Actor) error {
	// A source the caller cannot read is not found either, so reach is not
	// disclosed.
	target, err := s.store.GetAgentSessionSummary(ctx, strings.TrimSpace(input.ForkSessionID))
	if err != nil || !s.canReadSession(ctx, actor, target) {
		return &statusError{http.StatusNotFound, fmt.Errorf("fork source session not found")}
	}
	// The store gives the fork its own native session, copied from the
	// source's; it runs on the source's agent so that copy is on its device.
	input.ForkSessionID = target.ID
	input.NativeSessionID = ""
	input.Provider = target.Provider
	input.AgentID = target.AgentID
	if input.ProfileID == "" {
		input.ProfileID = target.ProfileID
	}
	input.WorkspaceID = target.WorkspaceID
	return nil
}

// dispatchNamingJob hands a naming job to its device; one it does not take
// fails with what failed.
func (s *Server) dispatchNamingJob(ctx context.Context, job store.AgentSession) (store.AgentSession, error) {
	return s.sessionService.DispatchOrFail(ctx, job, func(err error) string { return err.Error() })
}

// CreateSessionAndDispatch starts a session for an integration (Feishu)
// whose messages name no agent: one its input does not resolve runs on the
// workspace's first connected agent, else its first.
func (s *Server) CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	if err := s.sessionService.PickDevice(ctx, &input, true); err != nil {
		return store.AgentSession{}, err
	}
	return s.sessionService.CreateAndDispatch(ctx, input, sessions.StartOptions{Reconcile: true})
}

// SendSessionMessage delivers a follow-up to a session on behalf of an
// integration (Feishu) that acts with the workspace owner's authority. Its
// messages do not wait for an offline device: the chat says so at once,
// as for a new topic (CreateSessionAndDispatch).
func (s *Server) SendSessionMessage(ctx context.Context, sessionID, message string, attachments []store.ChatAttachment) error {
	if session, err := s.store.GetAgentSessionSummary(ctx, sessionID); err == nil && !s.hub.HasConnection(session.DeviceID) {
		if _, waitErr := s.hub.waitForConnection(ctx, session.DeviceID); waitErr != nil {
			return &statusError{http.StatusConflict, waitErr}
		}
	}
	_, err := s.sessionService.Send(ctx, sessionID, store.SendAgentSessionInput{Prompt: message, Attachments: attachments}, nil)
	return err
}

// SaveAttachments stores the files an integration (Feishu) received with
// one message in the workspace's attachments on its device, as a person's
// upload is and within the same limit.
func (s *Server) SaveAttachments(ctx context.Context, workspaceID string, files []feishu.MessageFile) ([]store.ChatAttachment, error) {
	total := 0
	for _, file := range files {
		total += len(file.Data)
	}
	if total > maxAttachmentUploadBytes {
		return nil, fmt.Errorf("the files hold more than %d MB, the most one message may bring", maxAttachmentUploadBytes>>20)
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	attachments := make([]store.ChatAttachment, 0, len(files))
	for index, file := range files {
		mimeType := file.MIMEType
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = cmp.Or(mime.TypeByExtension(strings.ToLower(filepath.Ext(sanitizeAttachmentName(file.Name)))), mimeType)
		}
		data := bytes.NewReader(file.Data)
		attachment, err := s.storeAttachment(ctx, workspace, now, index, file.Name, mimeType, int64(len(file.Data)), func(buffer []byte) (int, error) {
			return io.ReadFull(data, buffer)
		})
		if err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}
