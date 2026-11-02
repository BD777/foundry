package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// deviceTurnsRunningCode marks the refusal to remove a connected device
// while turns run on it; the web asks the person and sends
// ?stopRunningTurns=true to remove it anyway.
const deviceTurnsRunningCode = "device_turns_running"

// deviceRemovalPurgeInterval is how often the server looks for removed
// devices whose data is left, besides when a removal wakes it.
const deviceRemovalPurgeInterval = time.Hour

// handleDeleteDevice removes a device and everything it owned: its
// workspaces with their chats, sessions, issues and queues, its skills,
// resources, connectors and settings. Only a tombstone is kept, so its worker
// is told "device_removed" (4001 close, HTTP 410) and parks. The answer comes
// once the device is tombstoned and its worker dropped; the data, which can
// be large, is deleted right after beside requests (purgeRemovedDevices).
func (s *Server) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("deviceId"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	device, err := s.store.RemoveDevice(r.Context(), store.RemoveDeviceInput{
		ID:               id,
		Connected:        s.hub.HasConnection(id),
		StopRunningTurns: r.URL.Query().Get("stopRunningTurns") == "true",
	})
	var running *store.DeviceTurnsRunningError
	if errors.As(err, &running) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": err.Error(), "code": deviceTurnsRunningCode, "runningTurns": running.Turns,
		})
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// Dropped before its data goes, so the worker writes nothing more.
	s.hub.closeRemovedDevice(id)
	s.deviceRemovals.kick()
	s.projectionsChanged("")
	writeResult(w, device, nil)
}

// purgeRemovedDevices deletes the data of removed devices; what is left when
// the server stops is deleted at its next start (RunMaintenance).
func (s *Server) purgeRemovedDevices(ctx context.Context) {
	if err := s.store.PurgeRemovedDevices(ctx); err != nil {
		if ctx.Err() == nil {
			log.Printf("purge removed devices: %v", err)
		}
		return
	}
	s.projectionsChanged("")
}

// deviceRemovals wakes the device-removals background job.
type deviceRemovals struct {
	once    sync.Once
	pending chan struct{}
}

func (d *deviceRemovals) kicks() chan struct{} {
	d.once.Do(func() { d.pending = make(chan struct{}, 1) })
	return d.pending
}

func (d *deviceRemovals) kick() {
	select {
	case d.kicks() <- struct{}{}:
	default:
	}
}

// refuseRemovedDevice answers a worker whose credential belonged to a
// removed device the way it parks on: the daemon socket is accepted and
// closed with 4001/device_removed, any other request gets 410.
func (s *Server) refuseRemovedDevice(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/daemon/ws" || !websocket.IsWebSocketUpgrade(r) {
		writeError(w, http.StatusGone, wsDeviceRemovedReason)
		return
	}
	socket, err := s.hub.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer socket.Close()
	_ = socket.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(wsDeviceRemovedCloseCode, wsDeviceRemovedReason),
		time.Now().Add(closeFrameGrace))
}
