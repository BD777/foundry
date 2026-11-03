package sessions

import (
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
// first (httpapi's dispatchQueuedAgentSessions); the worker runs at most its
// maxConcurrentTasks at once. One still waiting after OfflineWaitLimit
// fails with the reason; the person or the agent that started it can
// cancel it meanwhile (Cancel).

// OfflineWaitLimit is how long queued work waits for its offline device
// before it fails.
var OfflineWaitLimit = 24 * time.Hour

// UnstartedNoticeAfter is how long a session waits queued, its device
// connected, before its transcript says what it is waiting for. A device on
// a slow or jammed link can take that long to report the start.
var UnstartedNoticeAfter = 3 * time.Minute

// RunnerSwitchNoticeAfter is how long a message held for an updated runner
// waits before the transcript says so.
var RunnerSwitchNoticeAfter = 15 * time.Second

// DispatchOrWait hands a queued session its viewers know of to its device
// or, while that device is offline, leaves it waiting for it. One its
// connected device does not take fails, with ErrLocalDaemonNotConnected.
func (s *Service) DispatchOrWait(ctx context.Context, session store.AgentSession) (store.AgentSession, error) {
	if session.DeviceID != "" && !s.devices.Connected(session.DeviceID) {
		return s.waitForDevice(ctx, session), nil
	}
	if err := s.devices.Dispatch(session); err != nil {
		if session.DeviceID != "" && !s.devices.Connected(session.DeviceID) {
			// It went away meanwhile.
			return s.waitForDevice(ctx, session), nil
		}
		return s.FailUndelivered(ctx, session, NotConnected(err)), ErrLocalDaemonNotConnected
	}
	return session, nil
}

// DispatchOrFail hands a session its viewers know of to its device. One the
// device does not take fails with failure(err) as its error (see
// FailUndelivered). It comes back failed, with the dispatch's error.
func (s *Service) DispatchOrFail(ctx context.Context, session store.AgentSession, failure func(error) string) (store.AgentSession, error) {
	if err := s.devices.Dispatch(session); err != nil {
		return s.FailUndelivered(ctx, session, failure(err)), err
	}
	return session, nil
}

// FailUndelivered fails a session its device did not take, and tells it
// like any other end, so what reacts to an ended session follows (the
// chat's queued messages, Feishu's card, naming).
func (s *Service) FailUndelivered(ctx context.Context, session store.AgentSession, reason string) store.AgentSession {
	failed, err := s.store.FailAgentSession(ctx, session.ID, reason)
	if err != nil {
		log.Printf("fail session %s its device did not take: %v", session.ID, err)
		return failed
	}
	s.events.Changed(ctx, Completed, failed)
	return failed
}

// NotConnected records a failed dispatch as the device not taking it.
func NotConnected(error) string { return ErrLocalDaemonNotConnected.Error() }

// waitForDevice writes in the session's transcript, once per input, that
// it waits for its offline device, and tells its viewers it still waits.
func (s *Service) waitForDevice(ctx context.Context, session store.AgentSession) store.AgentSession {
	event := deviceWaitNotice(session, s.devices.Label(ctx, session.DeviceID), time.Now().UTC())
	added, err := s.store.AddQueuedSessionNotice(ctx, event, session.Input.ID)
	if err != nil {
		log.Printf("note session %s waits for device %s: %v", session.ID, session.DeviceID, err)
		return session
	}
	if !added {
		return session
	}
	s.events.Recorded(ctx, session.WorkspaceID, event)
	// Viewers show a session that receives an event as running.
	if current, err := s.store.GetAgentSessionSummary(ctx, session.ID); err == nil && current.Status == "queued" {
		s.events.Changed(ctx, Queued, current)
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
		Label:     store.EventLabelDeviceWait,
		Detail: fmt.Sprintf("%s is offline. This waits and starts by itself when it is back online; it fails if it stays offline for %s.",
			device, readableLag(OfflineWaitLimit)),
		Level: "warning",
	}
}

// WaitsForDevice reports whether the session is queued for a device that
// is offline.
func (s *Service) WaitsForDevice(session store.AgentSession) bool {
	return session.Status == "queued" && session.DeviceID != "" && !s.devices.Connected(session.DeviceID)
}

// DeviceWaitNote tells the agent that started or messaged a session that
// it waits for its offline device; "" when it does not.
func (s *Service) DeviceWaitNote(ctx context.Context, session store.AgentSession) string {
	if !s.WaitsForDevice(session) {
		return ""
	}
	device := s.devices.Label(ctx, session.DeviceID)
	return fmt.Sprintf("%s is offline. This is queued and starts by itself, in order, when %s is back online: do not send it again, and tell the person it will start when %s is back. It fails if %s stays offline for %s; cancel_session cancels it.",
		device, device, device, device, readableLag(OfflineWaitLimit))
}

// ExpireDeviceWaits fails the queued sessions whose device has been offline
// for longer than OfflineWaitLimit since they were queued.
func (s *Service) ExpireDeviceWaits(ctx context.Context, now time.Time) error {
	queued, err := s.store.QueuedAgentSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range queued {
		since, ok := QueuedSince(session)
		if !ok || now.Sub(since) < OfflineWaitLimit || !s.WaitsForDevice(session) {
			continue
		}
		device := s.devices.Label(ctx, session.DeviceID)
		reason := fmt.Sprintf("%s stayed offline for %s, so this was not started. Send it again once %s is back online.",
			device, readableLag(OfflineWaitLimit), device)
		failed, err := s.store.FailAgentSession(ctx, session.ID, reason)
		if err != nil {
			log.Printf("expire session %s waiting for device %s: %v", session.ID, session.DeviceID, err)
			continue
		}
		s.events.Changed(ctx, Completed, failed)
	}
	return nil
}

// NoticeUnstarted tells each session that waits for a connected
// device to start it, once per input, that it is waiting and on what. It
// only says so: the session stays queued, nothing is failed or sent again
// (a device that reconnects is sent its queued sessions as always).
func (s *Service) NoticeUnstarted(ctx context.Context) error {
	queued, err := s.store.QueuedAgentSessions(ctx)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, session := range queued {
		since, ok := QueuedSince(session)
		if !ok || session.DeviceID == "" {
			continue
		}
		// A device switching to an updated runner holds new turns for it,
		// briefly: the person hears why at once, not as a device that
		// does not answer (DEV-072).
		link := s.devices.Link(session.DeviceID)
		switching := link.RunnerReported && link.HeldTurns > 0 && (link.RunnerState == "pending" || link.RunnerState == "switching")
		after := UnstartedNoticeAfter
		if switching {
			after = RunnerSwitchNoticeAfter
		}
		if now.Sub(since) < after {
			continue
		}
		// Waiting counts from when the device could take it: one queued
		// while it was away is sent once it connects again.
		if !link.Connected || (!switching && now.Sub(link.ConnectedAt) < UnstartedNoticeAfter) {
			continue
		}
		// The device's name as the person sees it, not the host name its
		// connection reported.
		device := s.devices.Label(ctx, session.DeviceID)
		event := unstartedSessionNotice(session, device, link.Lag, now)
		if switching {
			event = runnerSwitchNotice(session, device, link.RunnerState == "switching", now)
		}
		added, err := s.store.AddQueuedSessionNotice(ctx, event, session.Input.ID)
		if err != nil {
			log.Printf("notice unstarted session %s: %v", session.ID, err)
			continue
		}
		if !added {
			continue
		}
		s.events.Recorded(ctx, session.WorkspaceID, event)
		// Viewers show a session that receives an event as running; this
		// one still waits, as the session itself says.
		if current, err := s.store.GetAgentSessionSummary(ctx, session.ID); err == nil && current.Status == "queued" {
			s.events.Changed(ctx, Queued, current)
		}
	}
	return nil
}

// QueuedSince is when the session's input was queued.
func QueuedSince(session store.AgentSession) (time.Time, bool) {
	for _, value := range []string{session.Input.At, session.LastActivityAt} {
		if at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
			return at.UTC(), true
		}
	}
	return time.Time{}, false
}

// unstartedSessionNotice is the transcript's notice for the session's
// current input, under an id of its own so it is written once.
func unstartedSessionNotice(session store.AgentSession, device string, lag time.Duration, now time.Time) store.AgentSessionEvent {
	id := "evt_" + session.ID + "_waiting_for_device"
	if inputID := strings.TrimSpace(session.Input.ID); inputID != "" {
		id = "evt_" + session.ID + "_" + inputID + "_waiting_for_device"
	}
	detail := fmt.Sprintf("Waiting for %s to start this message…", device)
	if lag >= time.Minute {
		detail += fmt.Sprintf(" What it sends reaches Foundry about %s late.", readableLag(lag))
	}
	return store.AgentSessionEvent{
		ID:        id,
		SessionID: session.ID,
		At:        now.Format(time.RFC3339Nano),
		Label:     store.EventLabelDeviceWait,
		Detail:    detail,
		Level:     "warning",
	}
}

// runnerSwitchNotice says a message waits for the device's updated session
// runner, written once per input like the device notice.
func runnerSwitchNotice(session store.AgentSession, device string, starting bool, now time.Time) store.AgentSessionEvent {
	event := unstartedSessionNotice(session, device, 0, now)
	event.ID = strings.TrimSuffix(event.ID, "_waiting_for_device") + "_runner_switch"
	event.Label = store.EventLabelWorkerUpdate
	event.Detail = fmt.Sprintf("%s is switching to an updated session runner. This message starts within a minute: on the new runner, or on the current one if its turns keep running. The device's owner can switch now on its Devices page.", device)
	if starting {
		event.Detail = fmt.Sprintf("%s is starting its updated session runner. This message starts as soon as the runner answers.", device)
	}
	event.Level = "info"
	return event
}

// readableLag is a lag in minutes, or hours and minutes.
func readableLag(lag time.Duration) string {
	minutes := int(lag.Round(time.Minute) / time.Minute)
	if minutes < 60 {
		return fmt.Sprintf("%d min", minutes)
	}
	if minutes%60 == 0 {
		return fmt.Sprintf("%d h", minutes/60)
	}
	return fmt.Sprintf("%d h %d min", minutes/60, minutes%60)
}
