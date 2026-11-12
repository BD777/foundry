package assistant

import (
	"cmp"
	"context"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A computer coming back (docs/personal-agent.md §6): when one of the
// person's computers connects again after being away, the assistant
// conversations with something that waited for it hear so, as a server
// notice merged with the task events (notices) and never while the
// assistant is stopped: the helpers queued for it, which start by
// themselves now (work sent to an offline computer waits for it,
// sessions.Service.WaitsForDevice), the helpers on it still running or
// waiting, the helpers that failed while it was offline (one that waited
// past sessions.OfflineWaitLimit) and the writes the assistant was refused
// for that reason. A connection that drops for less than deviceBackAfter
// and comes back tells nothing about the helpers; a refused write is told
// whatever the absence. What this follows lives in memory: after a server
// restart nothing was away.

// deviceBackAfter is how long a computer is away before the helpers on it
// are said to have waited for it.
var deviceBackAfter = time.Minute

// offlineRefusalsMax bounds the refused writes kept per computer.
const offlineRefusalsMax = 20

// OfflineRefusal is what the assistant could not do because the computer
// was offline (a write refused, a helper that failed), for the
// conversation that tried, as the back notice lists it.
type OfflineRefusal struct {
	UserID, AssistantID, ConversationID, Line string
}

// deviceWaits keeps the refused writes per computer until it
// comes back, and the drop each computer's return was last told for.
type deviceWaits struct {
	mu       sync.Mutex
	refusals map[string][]OfflineRefusal
	told     map[string]string
}

func (w *deviceWaits) refused(deviceID string, refusal OfflineRefusal) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.refusals == nil {
		w.refusals = map[string][]OfflineRefusal{}
	}
	kept := append(w.refusals[deviceID], refusal)
	if len(kept) > offlineRefusalsMax {
		kept = kept[len(kept)-offlineRefusalsMax:]
	}
	w.refusals[deviceID] = kept
}

// back takes the computer's refused writes, and reports whether its drop
// (dropID) is news: a hello sent again on the same connection is not.
func (w *deviceWaits) back(deviceID, dropID string) ([]OfflineRefusal, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	refusals := w.refusals[deviceID]
	delete(w.refusals, deviceID)
	if w.told == nil {
		w.told = map[string]string{}
	}
	news := dropID != "" && w.told[deviceID] != dropID
	if dropID != "" {
		w.told[deviceID] = dropID
	}
	return refusals, news
}

// NoteOfflineRefusal keeps a write refused because its computer is offline
// for when that computer is back.
func (s *Service) NoteOfflineRefusal(ctx context.Context, scope Scope, tool string, write Write, err error) {
	if !errors.Is(err, sessions.ErrLocalDaemonNotConnected) {
		return
	}
	deviceID := write.DeviceID
	if deviceID == "" && write.WorkspaceID != "" {
		if workspace, err := s.store.GetWorkspace(ctx, write.WorkspaceID); err == nil {
			deviceID = workspace.DeviceID
		}
	}
	if deviceID == "" || scope.SessionID == "" {
		return
	}
	s.deviceWaits.refused(deviceID, OfflineRefusal{
		UserID: scope.Agent.UserID, AssistantID: scope.Agent.ID, ConversationID: scope.SessionID,
		Line: s.sayTask(ctx, scope.Agent, "refusedOffline", strings.TrimSpace(tool+": "+cutSummary(write.ArgsSummary))),
	})
}

// DeviceBack tells each assistant conversation what waited for
// the computer that just connected.
func (s *Service) DeviceBack(ctx context.Context, deviceID string) {
	now := time.Now()
	away, dropID, known := s.devices.AwayFor(deviceID, now)
	refusals, news := s.deviceWaits.back(deviceID, dropID)
	type conversation struct {
		assistantID string
		lines       []string
	}
	conversations := map[string]*conversation{}
	order := []string{}
	add := func(assistantID, conversationID, line string) {
		if conversationID == "" {
			return
		}
		if conversations[conversationID] == nil {
			conversations[conversationID] = &conversation{assistantID: assistantID}
			order = append(order, conversationID)
		}
		conversations[conversationID].lines = append(conversations[conversationID].lines, line)
	}
	if known && news && away >= deviceBackAfter {
		sessions, err := s.store.UnsettledAgentSessionsOnDevice(ctx, deviceID)
		if err != nil {
			log.Printf("personal agent: helpers on %s that waited for it: %v", deviceID, err)
		}
		for _, session := range sessions {
			agent, task, ok := s.TaskOf(ctx, session)
			if !ok || (task.Status != store.PersonalAgentTaskQueued && task.Status != store.PersonalAgentTaskRunning && task.Status != store.PersonalAgentTaskAsking) {
				continue
			}
			add(agent.ID, task.ConversationSessionID, s.waitLine(ctx, agent, task, session))
		}
	}
	for _, refusal := range refusals {
		add(refusal.AssistantID, refusal.ConversationID, refusal.Line)
	}
	if len(order) == 0 {
		return
	}
	label := cmp.Or(s.devices.Labels(ctx)[deviceID], deviceID)
	for _, conversationID := range order {
		waited := conversations[conversationID]
		agent, err := s.store.GetAssistant(ctx, waited.assistantID)
		if err != nil || agent.State != store.PersonalAgentActive {
			continue
		}
		language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
		text := s.sayTask(ctx, agent, "back", label, strings.Join(waited.lines, "\n- "))
		s.notices.add(conversationID, language, text, now, func(text string) {
			// The person may have pressed stop meanwhile.
			current, err := s.store.GetAssistant(context.Background(), agent.ID)
			if err != nil || current.State != store.PersonalAgentActive {
				return
			}
			s.tell(context.Background(), conversationID, text)
		})
	}
}

// waitLine is a helper that waited for its computer, as the
// back notice lists it: one still queued is being started.
func (s *Service) waitLine(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) string {
	if session.Status == "queued" {
		return s.sayTask(ctx, agent, "startsNow", s.taskWork(ctx, agent, task, session))
	}
	return s.sayTask(ctx, agent, "waited", s.taskWork(ctx, agent, task, session), session.Status)
}

// noteHelperFailedOffline keeps a helper that failed while its computer
// was offline (it waited for it too long, or stopped reporting) for when
// that computer is back.
func (s *Service) noteHelperFailedOffline(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) {
	if session.DeviceID == "" || task.ConversationSessionID == "" || s.devices.Connected(session.DeviceID) {
		return
	}
	s.deviceWaits.refused(session.DeviceID, OfflineRefusal{
		UserID: agent.UserID, AssistantID: agent.ID, ConversationID: task.ConversationSessionID,
		Line: s.sayTask(ctx, agent, "failedOffline", s.taskWork(ctx, agent, task, session)),
	})
}

// OfflineRefusals are what the assistant's conversations could not do
// while the computer deviceID was offline, kept until it is back.
func (s *Service) OfflineRefusals(deviceID string) []OfflineRefusal {
	s.deviceWaits.mu.Lock()
	defer s.deviceWaits.mu.Unlock()
	return slices.Clone(s.deviceWaits.refusals[deviceID])
}
