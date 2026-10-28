package httpapi

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// unstartedSessionNoticeAfter is how long a session waits queued, its device
// connected, before its transcript says what it is waiting for. A device on
// a slow or jammed link can take that long to report the start.
var unstartedSessionNoticeAfter = 3 * time.Minute

// waitingForDeviceLabel names the notice event in the transcript.
const waitingForDeviceLabel = "Waiting for device"

// noticeUnstartedSessions tells each session that waits for a connected
// device to start it, once per input, that it is waiting and on what. It
// only says so: the session stays queued, nothing is failed or sent again
// (a device that reconnects is sent its queued sessions as always).
func (s *Server) noticeUnstartedSessions(ctx context.Context) error {
	sessions, err := s.store.QueuedAgentSessions(ctx)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, session := range sessions {
		since, ok := sessionQueuedSince(session)
		if !ok || session.DeviceID == "" {
			continue
		}
		// A device switching to an updated runner holds new turns for it,
		// briefly: the person hears why at once, not as a device that
		// does not answer (DEV-072).
		runner, reported := s.deviceRunners.get(session.DeviceID, s.hub.connectionFor(session.DeviceID))
		switching := reported && runner.HeldTurns > 0 && (runner.State == "pending" || runner.State == "switching")
		after := unstartedSessionNoticeAfter
		if switching {
			after = runnerSwitchNoticeAfter
		}
		if now.Sub(since) < after {
			continue
		}
		_, lag, connectedAt, connected := s.hub.connectedDevice(session.DeviceID)
		// Waiting counts from when the device could take it: one queued
		// while it was away is sent once it connects again.
		if !connected || (!switching && now.Sub(connectedAt) < unstartedSessionNoticeAfter) {
			continue
		}
		// The device's name as the person sees it, not the host name its
		// connection reported.
		device := s.deviceLabel(ctx, session.DeviceID)
		event := unstartedSessionNotice(session, device, lag, now)
		if switching {
			event = runnerSwitchNotice(session, device, runner.State == "switching", now)
		}
		added, err := s.store.AddQueuedSessionNotice(ctx, event, session.Input.ID)
		if err != nil {
			log.Printf("notice unstarted session %s: %v", session.ID, err)
			continue
		}
		if !added {
			continue
		}
		s.sessions.recorded(ctx, session.WorkspaceID, event)
		// Viewers show a session that receives an event as running; this
		// one still waits, as the session itself says.
		if current, err := s.store.GetAgentSessionSummary(ctx, session.ID); err == nil && current.Status == "queued" {
			s.sessions.changed(ctx, sessionQueued, current)
		}
	}
	return nil
}

// sessionQueuedSince is when the session's input was queued.
func sessionQueuedSince(session store.AgentSession) (time.Time, bool) {
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
		Label:     waitingForDeviceLabel,
		Detail:    detail,
		Level:     "warning",
	}
}

// runnerSwitchNoticeAfter is how long a message held for an updated runner
// waits before the transcript says so.
var runnerSwitchNoticeAfter = 15 * time.Second

const workerUpdateLabel = "Worker update in progress"

// runnerSwitchNotice says a message waits for the device's updated session
// runner, written once per input like the device notice.
func runnerSwitchNotice(session store.AgentSession, device string, starting bool, now time.Time) store.AgentSessionEvent {
	event := unstartedSessionNotice(session, device, 0, now)
	event.ID = strings.TrimSuffix(event.ID, "_waiting_for_device") + "_runner_switch"
	event.Label = workerUpdateLabel
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
