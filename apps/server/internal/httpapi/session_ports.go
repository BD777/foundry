package httpapi

import (
	"context"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The session service's ports (sessions.Ports) over the server: its device
// hub, what it decides around sessions, and the chat list.

// newSessionService is the server's session lifecycle, telling events.
func newSessionService(s *Server, events sessions.Notifier) *sessions.Service {
	return sessions.New(s.store, events, sessions.Ports{
		Devices: sessionDevices{s},
		Policy:  sessionPolicy{s},
		Chats:   sessionChats{s},
		Work:    &s.workMu,
	})
}

type sessionDevices struct{ s *Server }

func (d sessionDevices) Connected(deviceID string) bool { return d.s.hub.HasConnection(deviceID) }

func (d sessionDevices) Link(deviceID string) sessions.DeviceLink {
	runner, reported := d.s.deviceRunners.get(deviceID, d.s.hub.connectionFor(deviceID))
	_, lag, connectedAt, connected := d.s.hub.connectedDevice(deviceID)
	return sessions.DeviceLink{
		Connected: connected, ConnectedAt: connectedAt, Lag: lag,
		RunnerReported: reported, RunnerState: runner.State, HeldTurns: runner.HeldTurns,
	}
}

func (d sessionDevices) Label(ctx context.Context, deviceID string) string {
	return d.s.deviceLabel(ctx, deviceID)
}

func (d sessionDevices) Dispatch(session store.AgentSession) error {
	return d.s.hub.DispatchAgentSession(session)
}

func (d sessionDevices) Steer(ctx context.Context, session store.AgentSession, steer sessions.Steer) error {
	return d.s.hub.SteerAgentSessionWith(ctx, session, wsSteerSessionPayload(steer))
}

func (d sessionDevices) Cancel(ctx context.Context, session store.AgentSession) (bool, error) {
	return d.s.hub.CancelAgentSession(ctx, session)
}

func (d sessionDevices) NoAnswer(err error) bool {
	var noAnswer *deviceNoAnswerError
	return errors.As(err, &noAnswer) || errors.Is(err, context.DeadlineExceeded)
}

type sessionPolicy struct{ s *Server }

func (p sessionPolicy) Reconcile(ctx context.Context, session store.AgentSession) (store.AgentSession, bool, error) {
	return p.s.reconcileAgentSession(ctx, session)
}

func (p sessionPolicy) ArchivedWorkspace(ctx context.Context, workspaceID string) error {
	return archivedWorkspace(ctx, p.s.store, workspaceID)
}

func (p sessionPolicy) UnservedWorkspace(ctx context.Context, workspaceID string) error {
	if refusal := p.MovingWorkspace(ctx, workspaceID); refusal != nil {
		return refusal
	}
	return unservedWorkspace(ctx, p.s.store, workspaceID)
}

func (p sessionPolicy) MovingWorkspace(ctx context.Context, workspaceID string) error {
	return movingWorkspace(ctx, p.s.store, workspaceID)
}

func (p sessionPolicy) RequireVerifierDevice(ctx context.Context, input store.CreateAgentSessionInput) error {
	return p.s.requireVerifierDevice(ctx, input)
}

func (p sessionPolicy) AdmitAssistantSession(ctx context.Context, input store.CreateAgentSessionInput) (store.PersonalAgent, bool, error) {
	return p.s.assistant.AdmitSession(ctx, input)
}

func (p sessionPolicy) RecordAssistantTask(ctx context.Context, agent store.PersonalAgent, conversationID string, session store.AgentSession) {
	p.s.assistant.RecordTask(ctx, agent, conversationID, session)
}

func (p sessionPolicy) AdmitAssistantTurn(ctx context.Context, session store.AgentSession) error {
	return p.s.assistant.AdmitTurn(ctx, session)
}

func (p sessionPolicy) ChooseSessionAccount(ctx context.Context, input *store.CreateAgentSessionInput) error {
	return p.s.chooseSessionAccount(ctx, input)
}

func (p sessionPolicy) ChooseRuntimeSwitch(ctx context.Context, session store.AgentSession, input *store.SendAgentSessionInput) error {
	return p.s.chooseRuntimeSwitch(ctx, session, input)
}

type sessionChats struct{ s *Server }

func (c sessionChats) Created(session store.AgentSession, adoptedChatID string) {
	c.s.chats.sessionCreated(session, adoptedChatID)
}

func (c sessionChats) AnnounceQueue(ctx context.Context, workspaceID, chatID string) {
	c.s.chats.announceQueue(ctx, workspaceID, chatID)
}

func (c sessionChats) NameGroup(workspaceID, groupID, parentSessionID string) {
	work := c.s.hub.work
	work.Go(func() { c.s.titles.StartGroupName(work.ctx, workspaceID, groupID, parentSessionID) })
}
