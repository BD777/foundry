package httpapi

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// deviceDisconnects keeps each device's last drop: the server's reason when
// the socket ended, then the worker's own account once it reconnects. It
// lives in memory; a server restart starts it over.
type deviceDisconnects struct {
	mu   sync.Mutex
	last map[string]store.DeviceDisconnect
}

// serverSide records why the server ended or lost a device's connection.
func (d *deviceDisconnects) serverSide(deviceID string, reason error, at time.Time) {
	if deviceID == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil {
		d.last = map[string]store.DeviceDisconnect{}
	}
	entry := store.DeviceDisconnect{At: at.UTC().Format(time.RFC3339)}
	if reason != nil {
		entry.ServerReason = reason.Error()
	}
	d.last[deviceID] = entry
}

// workerSide attaches the worker's latest report to the last drop.
func (d *deviceDisconnects) workerSide(deviceID string, reports []store.WorkerConnectionReport) {
	if deviceID == "" || len(reports) == 0 {
		return
	}
	latest := reports[len(reports)-1]
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil {
		d.last = map[string]store.DeviceDisconnect{}
	}
	entry := d.last[deviceID]
	if entry.At == "" {
		entry.At = latest.ClosedAt
	}
	entry.Worker = &latest
	d.last[deviceID] = entry
}

func (d *deviceDisconnects) lookup(deviceID string) (store.DeviceDisconnect, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	entry, ok := d.last[deviceID]
	return entry, ok
}

// withDisconnects adds each device's last drop to a projection.
func (h *DaemonHub) withDisconnects(devices []store.DeviceProjection) []store.DeviceProjection {
	for i := range devices {
		if entry, ok := h.disconnects.lookup(devices[i].ID); ok {
			entry := entry
			devices[i].LastDisconnect = &entry
		}
	}
	return devices
}

// describeConnectionReport is one readable line for a worker's report.
func describeConnectionReport(report store.WorkerConnectionReport) string {
	seconds := func(ms int64) string {
		return fmt.Sprintf("%ds", (ms+500)/1000)
	}
	parts := []string{
		"lasted " + seconds(report.DurationMs),
		"closed by " + report.ClosedBy,
	}
	if report.CloseCode != 0 {
		parts = append(parts, fmt.Sprintf("code=%d", report.CloseCode))
	}
	if report.CloseReason != "" {
		parts = append(parts, fmt.Sprintf("reason=%q", report.CloseReason))
	}
	if report.Error != "" {
		parts = append(parts, "error="+report.Error)
	}
	if report.SinceServerDataMs != 0 {
		parts = append(parts, "last data from server "+seconds(report.SinceServerDataMs)+" before")
	}
	if report.BytesSent != 0 || report.BytesReceived != 0 {
		parts = append(parts, fmt.Sprintf("worker sent %d bytes, received %d bytes", report.BytesSent, report.BytesReceived))
	}
	proxy := report.Proxy
	if proxy == "" {
		proxy = "none"
	}
	parts = append(parts, "proxy="+proxy)
	if report.MaxLagMs != 0 {
		parts = append(parts, fmt.Sprintf("max event-loop delay %dms", report.MaxLagMs))
	}
	return strings.Join(parts, ", ")
}

// logWorkerConnections writes the worker's accounts of its previous
// connections and keeps the latest for the device page.
func (h *DaemonHub) logWorkerConnections(registration store.DaemonRegistration) {
	label := registration.Device.Label
	if label == "" {
		label = registration.Device.ID
	}
	for _, report := range registration.Connections {
		log.Printf("device %s reconnected: previous connection %s", label, describeConnectionReport(report))
	}
	h.disconnects.workerSide(registration.Device.ID, registration.Connections)
}
