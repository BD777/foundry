package httpapi

import (
	"encoding/json"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sendSessionTimers sends a device that said hello the timers its sessions
// hold, one session per envelope. Its worker keeps them and fires the ones
// due while no process runs their session (handleDaemonTimerFire); a
// worker that never saw them reported (an older one ran the session, or
// its record was lost) adopts them, one that keeps them already keeps its
// own.
func (c *daemonConnection) sendSessionTimers() {
	timers, ok := c.hub.store.(store.SessionTimerStore)
	if !ok {
		return
	}
	deviceID, _ := c.registrationSnapshot()
	if deviceID == "" {
		return
	}
	sessions, err := timers.DeviceSessionTimers(c.lifetime, deviceID, time.Now().UTC())
	if err != nil {
		log.Printf("listing the session timers of %s failed: %v", deviceID, err)
		return
	}
	for _, session := range sessions {
		payload, err := json.Marshal(session)
		if err != nil {
			continue
		}
		if !c.queue(wsEnvelope{Type: wsSessionTimersType, Payload: payload}) {
			return
		}
	}
}
