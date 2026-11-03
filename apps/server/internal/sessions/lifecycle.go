package sessions

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The one way sessions start, take messages and stop, whoever asks: the
// REST handlers (httpapi's sessions_http.go), MCP, the chat queue, timers
// and Feishu. A refusal is a Refusal.

// ControlTimeout is how long a steer or a stop waits for the
// session's device to answer.
var ControlTimeout = 8 * time.Second

// workDispatchKey marks a context whose caller already serializes with
// automatic work (WorkDispatch).
type workDispatchKey struct{}

// WorkDispatch marks ctx as automatic work's own dispatch, which holds the
// work lock (Ports.Work) itself: its sessions start without taking it.
func WorkDispatch(ctx context.Context) context.Context {
	return context.WithValue(ctx, workDispatchKey{}, true)
}

// StartOptions are how CreateAndDispatch starts a session beyond what every
// session gets.
type StartOptions struct {
	// Reconcile first settles the workspace's sessions whose device stopped
	// reporting (MCP and the server's own work start without it).
	Reconcile bool
	// FailOffline fails a session its device does not take, offline or
	// not, instead of leaving it waiting: the server's own work (assistant
	// maintenance, digest summaries), which retries by itself.
	FailOffline bool
	// Resume goes on with the session that already took the input's id, as
	// with a new one, after a restart between creating and dispatching it;
	// one that already settled comes back as it is. Without it, that is
	// the store's ErrSessionInputExists.
	Resume bool
	// BeforeDispatch, if any, runs once the store took the session and
	// before its device hears of it; a failure fails the session with its
	// error.
	BeforeDispatch func(ctx context.Context, session store.AgentSession) error
}

// CreateAndDispatch creates a session, tells its viewers and hands it to its
// device: the one way a new session starts, whoever starts it (a person,
// the chat queue, Feishu, an agent over MCP, the server's own work). A
// session for an offline device waits for it, queued; one its connected
// device does not take comes back failed, with ErrLocalDaemonNotConnected;
// a refused creation, with the store's error. opts says what else applies.
func (s *Service) CreateAndDispatch(ctx context.Context, input store.CreateAgentSessionInput, opts StartOptions) (store.AgentSession, error) {
	if input.ParentSessionID != "" && ctx.Value(workDispatchKey{}) != true {
		s.work.Lock()
		defer s.work.Unlock()
		parent, err := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID)
		if err == nil {
			list, err := s.store.ListSessionWork(ctx, parent.ID, "")
			if err != nil {
				return store.AgentSession{}, err
			}
			if list.Barrier {
				return store.AgentSession{}, &Refusal{http.StatusConflict, errors.New("automatic work is stopped for this conversation")}
			}
		}
	}
	if opts.Reconcile && input.WorkspaceID != "" {
		if sessions, err := s.store.ListAgentSessionSummaries(ctx, input.WorkspaceID); err == nil {
			s.ReconcileAll(ctx, sessions)
		}
	}
	if refusal := s.policy.ArchivedWorkspace(ctx, input.WorkspaceID); refusal != nil {
		return store.AgentSession{}, refusal
	}
	if err := s.policy.RequireVerifierDevice(ctx, input); err != nil {
		return store.AgentSession{}, err
	}
	assistant, delegating, err := s.policy.AdmitAssistantSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	session, adoptedChatID, err := s.store.CreateAgentSessionAdopting(ctx, input)
	if errors.Is(err, store.ErrSessionInputExists) && opts.Resume {
		return s.resume(ctx, input.InputID, opts)
	}
	if err != nil {
		return store.AgentSession{}, err
	}
	if session.ParentSessionID != "" && input.ReportBack != nil && !*input.ReportBack {
		if err := s.store.SetChildReportBack(ctx, session.ID, false); err != nil {
			log.Printf("session %s: keep from reporting back: %v", session.ID, err)
		}
	}
	if delegating {
		s.policy.RecordAssistantTask(ctx, assistant, input.ParentSessionID, session)
	}
	s.events.Changed(ctx, Created, session)
	s.chats.Created(session, adoptedChatID)
	if chatID := adoptedChatID; chatID != "" {
		// The adopted native chat's queued messages are the session's now.
		s.chats.AnnounceQueue(ctx, session.WorkspaceID, chatID)
		s.chats.AnnounceQueue(ctx, session.WorkspaceID, session.ID)
	}
	if groupID := strings.TrimSpace(session.CreatedGroupID); groupID != "" {
		// Best-effort AI naming; failures keep the deterministic placeholder
		// name and never block session dispatch.
		s.chats.NameGroup(session.WorkspaceID, groupID, session.ParentSessionID)
	}
	return s.dispatchNew(ctx, session, opts)
}

// resume goes on with the session that took inputID (StartOptions.Resume).
func (s *Service) resume(ctx context.Context, inputID string, opts StartOptions) (store.AgentSession, error) {
	id, err := s.store.WorkRunInputSession(ctx, inputID)
	if err != nil {
		return store.AgentSession{}, errors.Join(store.ErrSessionInputExists, err)
	}
	session, err := s.store.GetAgentSessionSummary(ctx, id)
	if err != nil {
		return store.AgentSession{}, err
	}
	s.events.Changed(ctx, Created, session)
	return s.dispatchNew(ctx, session, opts)
}

// dispatchNew hands a session CreateAndDispatch started to its device.
func (s *Service) dispatchNew(ctx context.Context, session store.AgentSession, opts StartOptions) (store.AgentSession, error) {
	if opts.BeforeDispatch != nil {
		if err := opts.BeforeDispatch(ctx, session); err != nil {
			return s.FailUndelivered(ctx, session, err.Error()), err
		}
	}
	switch {
	case !store.IsActiveSessionStatus(session.Status):
		return session, nil
	case opts.FailOffline:
		return s.DispatchOrFail(ctx, session, NotConnected)
	default:
		return s.DispatchOrWait(ctx, session)
	}
}

// Send is the one way to talk to an existing session: a running session is
// steered, an idle one takes the message as its next input and is
// dispatched again, or waits for its offline device (DispatchOrWait). A
// refusal is a Refusal. beforeDelivery, if any, runs once the message is
// accepted and before the session's device hears of it: a steer it fails
// is not sent, a queued input it fails fails the session with its error.
func (s *Service) Send(ctx context.Context, sessionID string, input store.SendAgentSessionInput, beforeDelivery func(context.Context, store.AgentSession) error) (store.AgentSession, error) {
	session, err := s.store.GetAgentSessionRecord(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, err
	}
	if session.ArchivedAt != "" {
		return store.AgentSession{}, store.ErrSessionArchived
	}
	if session, _, err = s.policy.Reconcile(ctx, session); err != nil {
		return store.AgentSession{}, err
	}
	if !takesControl(session) {
		return store.AgentSession{}, &Refusal{http.StatusConflict, store.ErrSessionControlledByIssue}
	}
	if err := s.policy.AdmitAssistantTurn(ctx, session); err != nil {
		return store.AgentSession{}, err
	}
	message := strings.TrimSpace(input.Prompt)
	if store.IsActiveSessionStatus(session.Status) {
		if input.RequireIdle {
			return store.AgentSession{}, &Refusal{http.StatusConflict, store.ErrAgentSessionActive}
		}
		if input.AgentID != "" || input.Provider != "" || input.ProfileID != "" {
			return store.AgentSession{}, &Refusal{http.StatusConflict, errors.New("a running session keeps its runtime; switch it once it settles")}
		}
		// Files steer in with the message, as they arrive with any message.
		attachments := store.NormalizeChatAttachments(input.Attachments)
		if message == "" && len(attachments) == 0 {
			return store.AgentSession{}, &Refusal{http.StatusBadRequest, errors.New("message is required")}
		}
		if s.WaitsForDevice(session) {
			return store.AgentSession{}, &Refusal{http.StatusConflict, errors.New("this session already waits for its offline device: send more once it has started, or cancel it")}
		}
		if !s.devices.Connected(session.DeviceID) {
			return store.AgentSession{}, &Refusal{http.StatusConflict, ErrLocalDaemonNotConnected}
		}
		if beforeDelivery != nil {
			if err := beforeDelivery(ctx, session); err != nil {
				return store.AgentSession{}, &Refusal{http.StatusConflict, err}
			}
		}
		if err := s.RecordSteerSender(ctx, session.ID, &input); err != nil {
			return store.AgentSession{}, err
		}
		steerCtx, cancel := context.WithTimeout(ctx, ControlTimeout)
		defer cancel()
		steer := Steer{SentBySessionID: input.SentBySessionID, Message: message, Attachments: attachments, InputID: input.InputID, Delivery: input.Delivery}
		if input.Delivery == store.DeliveryBoundary {
			steer.BoundaryLimitMs = InboxBoundaryLimitMs
		}
		if err := s.devices.Steer(steerCtx, session, steer); err != nil {
			return store.AgentSession{}, &Refusal{cmp.Or(DeviceErrorStatus(err), http.StatusConflict), err}
		}
		session, err = s.store.GetAgentSessionRecord(ctx, session.ID)
		return session, err
	}
	if refusal := s.policy.UnservedWorkspace(ctx, session.WorkspaceID); refusal != nil {
		return store.AgentSession{}, &Refusal{http.StatusConflict, refusal}
	}
	if err := s.policy.ChooseRuntimeSwitch(ctx, session, &input); err != nil {
		return store.AgentSession{}, err
	}
	session, err = s.store.SendAgentSessionInput(ctx, session.ID, input)
	if err != nil {
		if errors.Is(err, store.ErrAgentSessionActive) {
			return store.AgentSession{}, &Refusal{http.StatusConflict, err}
		}
		return store.AgentSession{}, err
	}
	// A summary carries no events, so the input's own transcript events are
	// streamed too; otherwise viewers keep the previous turn as the latest.
	for _, event := range store.SessionInputEvents(session.ID, session.Input) {
		s.events.Recorded(ctx, session.WorkspaceID, event)
	}
	s.events.Changed(ctx, Queued, session)
	if beforeDelivery != nil {
		if err := beforeDelivery(ctx, session); err != nil {
			return s.FailUndelivered(ctx, session, err.Error()), &Refusal{http.StatusConflict, err}
		}
	}
	dispatched, err := s.DispatchOrWait(ctx, session)
	if err != nil {
		return dispatched, &Refusal{http.StatusConflict, err}
	}
	return dispatched, nil
}

// takesControl reports whether the session itself takes a message or a
// stop: a chat always, and an Issue's execution while it runs, steered and
// stopped like any running session. Otherwise its Issue does: the Issue
// clarifies, and continues in a next execution.
func takesControl(session store.AgentSession) bool {
	return session.Role == "" || session.Role == store.AgentSessionRoleIssueExecution && store.IsActiveSessionStatus(session.Status)
}

// RecordSteerSender keeps who steers input into sessionID before its device
// takes it, naming the input first when the caller did not: the device
// writes the message's event as evt_<input id>.
func (s *Service) RecordSteerSender(ctx context.Context, sessionID string, input *store.SendAgentSessionInput) error {
	if input.InputID == "" {
		input.InputID = uuid.NewString()
	}
	if input.SentBySessionID == "" {
		return nil
	}
	return s.store.RecordSessionInputSender(ctx, sessionID, input.InputID, input.SentBySessionID)
}

// Cancel stops the work a session is doing. It never cascades:
// sessions it created keep running. One that waits for its offline device
// is canceled on the server alone. orchestrator is the session that stops
// it, "" for a person. A refusal is a Refusal.
func (s *Service) Cancel(ctx context.Context, sessionID, orchestrator string) (store.AgentSession, error) {
	session, err := s.store.GetAgentSessionRecord(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, err
	}
	session, recovered, err := s.policy.Reconcile(ctx, session)
	if err != nil {
		return store.AgentSession{}, err
	}
	if !takesControl(session) {
		return store.AgentSession{}, &Refusal{http.StatusConflict, store.ErrSessionControlledByIssue}
	}
	if recovered || !store.IsActiveSessionStatus(session.Status) {
		return store.AgentSession{}, &Refusal{http.StatusConflict, errors.New("agent session is not active")}
	}
	if !s.WaitsForDevice(session) {
		if !s.devices.Connected(session.DeviceID) {
			return store.AgentSession{}, &Refusal{http.StatusConflict, ErrLocalDaemonNotConnected}
		}
		cancelCtx, cancel := context.WithTimeout(ctx, ControlTimeout)
		defer cancel()
		answered, err := s.devices.Cancel(cancelCtx, session)
		if err != nil {
			return store.AgentSession{}, &Refusal{cmp.Or(DeviceErrorStatus(err), http.StatusConflict), err}
		}
		if answered {
			// The turn had already answered; the stop ended only the background
			// work it waited for. The device reports it completed with that
			// answer, so it is not recorded as canceled.
			s.AuditControl(ctx, session, "Stopped by orchestrator", orchestrator)
			return session, nil
		}
	}
	cancelMessage := "Canceled by user"
	if orchestrator != "" {
		cancelMessage = "Canceled by orchestrator session"
	}
	session, err = s.store.CancelAgentSession(ctx, session.ID, cancelMessage)
	if err != nil {
		return store.AgentSession{}, err
	}
	s.AuditControl(ctx, session, "Canceled by orchestrator", orchestrator)
	s.events.Changed(ctx, Completed, session)
	return session, nil
}

// AuditControl records in the session's transcript that an orchestrating
// session (orchestrator; "" for a person, who is not recorded) controlled
// it, and streams the event like the transcript's others.
func (s *Service) AuditControl(ctx context.Context, session store.AgentSession, label, orchestrator string) {
	if orchestrator == "" {
		return
	}
	now := time.Now().UTC()
	event := store.AgentSessionEvent{
		ID:        fmt.Sprintf("audit_%d", now.UnixNano()),
		SessionID: session.ID,
		At:        now.Format(time.RFC3339Nano),
		Label:     label,
		Detail:    orchestrator,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{
			TaskID: orchestrator,
		},
	}
	if err := s.store.AppendAgentSessionEvent(ctx, event); err != nil {
		log.Printf("record %q on session %s: %v", label, session.ID, err)
		return
	}
	s.events.Recorded(ctx, session.WorkspaceID, event)
}
