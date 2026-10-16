package httpapi

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Work sent to an offline computer waits (docs/session-model.md): a new
// session or a follow-up for a workspace whose device is offline is
// accepted and stays queued, its transcript says what it waits for, and
// the device's hello sends it with the device's other queued work, oldest
// first (dispatchQueuedAgentSessions); the worker runs at most its
// maxConcurrentTasks at once. One still waiting after offlineWaitLimit
// fails with the reason; the person or the agent that started it can
// cancel it meanwhile (cancelSession).

// offlineWaitLimit is how long queued work waits for its offline device
// before it fails.
var offlineWaitLimit = 24 * time.Hour

// dispatchOrWait hands a queued session its viewers know of to its device
// or, while that device is offline, leaves it waiting for it. One its
// connected device does not take fails, with ErrLocalDaemonNotConnected.
func (s *Server) dispatchOrWait(ctx context.Context, session store.AgentSession) (store.AgentSession, error) {
	if session.DeviceID != "" && !s.hub.HasConnection(session.DeviceID) {
		return s.waitForDevice(ctx, session), nil
	}
	if err := s.hub.DispatchAgentSession(session); err != nil {
		if session.DeviceID != "" && !s.hub.HasConnection(session.DeviceID) {
			// It went away meanwhile.
			return s.waitForDevice(ctx, session), nil
		}
		return s.failUndelivered(ctx, session, notConnected(err)), ErrLocalDaemonNotConnected
	}
	return session, nil
}

// waitForDevice writes in the session's transcript, once per input, that
// it waits for its offline device, and tells its viewers it still waits.
func (s *Server) waitForDevice(ctx context.Context, session store.AgentSession) store.AgentSession {
	event := deviceWaitNotice(session, s.deviceLabel(ctx, session.DeviceID), time.Now().UTC())
	added, err := s.store.AddQueuedSessionNotice(ctx, event, session.Input.ID)
	if err != nil {
		log.Printf("note session %s waits for device %s: %v", session.ID, session.DeviceID, err)
		return session
	}
	if !added {
		return session
	}
	s.sessions.recorded(ctx, session.WorkspaceID, event)
	// Viewers show a session that receives an event as running.
	if current, err := s.store.GetAgentSessionSummary(ctx, session.ID); err == nil && current.Status == "queued" {
		s.sessions.changed(ctx, sessionQueued, current)
		return current
	}
	return session
}

// deviceWaitNotice is the transcript's notice that the session's current
// input waits for its offline device, under an id of its own.
func deviceWaitNotice(session store.AgentSession, device string, now time.Time) store.AgentSessionEvent {
	id := "evt_" + session.ID + "_waiting_for_device_online"
	if inputID := strings.TrimSpace(session.Input.ID); inputID != "" {
		id = "evt_" + session.ID + "_" + inputID + "_waiting_for_device_online"
	}
	return store.AgentSessionEvent{
		ID:        id,
		SessionID: session.ID,
		At:        now.Format(time.RFC3339Nano),
		Label:     waitingForDeviceLabel,
		Detail: fmt.Sprintf("%s is offline. This waits and starts by itself when it is back online; it fails if it stays offline for %s.",
			device, readableLag(offlineWaitLimit)),
		Level: "warning",
	}
}

// deviceLabel is the device's name as people know it.
func (s *Server) deviceLabel(ctx context.Context, deviceID string) string {
	return cmp.Or(s.deviceLabels(ctx)[deviceID], "Its computer")
}

// waitsForDevice reports whether the session is queued for a device that
// is offline.
func (s *Server) waitsForDevice(session store.AgentSession) bool {
	return session.Status == "queued" && session.DeviceID != "" && !s.hub.HasConnection(session.DeviceID)
}

// withTaskWaits marks the unfinished tasks whose session is queued for an
// offline computer with that computer's name (PersonalAgentTask.WaitingFor).
func (s *Server) withTaskWaits(ctx context.Context, tasks []store.PersonalAgentTask) []store.PersonalAgentTask {
	for i, task := range tasks {
		if task.SessionID == "" || (task.Status != store.PersonalAgentTaskQueued && task.Status != store.PersonalAgentTaskRunning) {
			continue
		}
		session, err := s.store.GetAgentSessionSummary(ctx, task.SessionID)
		if err == nil && s.waitsForDevice(session) {
			tasks[i].WaitingFor = s.deviceLabel(ctx, session.DeviceID)
		}
	}
	return tasks
}

// deviceWaitNote tells the agent that started or messaged a session that
// it waits for its offline device; "" when it does not.
func (s *Server) deviceWaitNote(ctx context.Context, session store.AgentSession) string {
	if !s.waitsForDevice(session) {
		return ""
	}
	device := s.deviceLabel(ctx, session.DeviceID)
	return fmt.Sprintf("%s is offline. This is queued and starts by itself, in order, when %s is back online: do not send it again, and tell the person it will start when %s is back. It fails if %s stays offline for %s; cancel_session cancels it.",
		device, device, device, device, readableLag(offlineWaitLimit))
}

// mcpSessionAnswer is a session a tool started or messaged, with the files
// that call handed over and, when it waits for its offline device, a note
// saying so.
func (s *Server) mcpSessionAnswer(ctx context.Context, session store.AgentSession, attachments []store.ChatAttachment) any {
	note := s.deviceWaitNote(ctx, session)
	if note == "" {
		return withDeliveredAttachments(session, attachments)
	}
	answer := mcpSessionWithAttachments{AgentSession: session, WaitingForDevice: note}
	if withFiles, ok := withDeliveredAttachments(session, attachments).(mcpSessionWithAttachments); ok {
		answer.DeliveredAttachments = withFiles.DeliveredAttachments
	}
	return answer
}

// expireDeviceWaits fails the queued sessions whose device has been offline
// for longer than offlineWaitLimit since they were queued.
func (s *Server) expireDeviceWaits(ctx context.Context, now time.Time) error {
	sessions, err := s.store.QueuedAgentSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		since, ok := sessionQueuedSince(session)
		if !ok || now.Sub(since) < offlineWaitLimit || !s.waitsForDevice(session) {
			continue
		}
		device := s.deviceLabel(ctx, session.DeviceID)
		reason := fmt.Sprintf("%s stayed offline for %s, so this was not started. Send it again once %s is back online.",
			device, readableLag(offlineWaitLimit), device)
		failed, err := s.store.FailAgentSession(ctx, session.ID, reason)
		if err != nil {
			log.Printf("expire session %s waiting for device %s: %v", session.ID, session.DeviceID, err)
			continue
		}
		s.sessions.changed(ctx, sessionCompleted, failed)
	}
	return nil
}
