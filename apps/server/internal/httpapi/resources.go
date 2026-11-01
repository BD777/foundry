package httpapi

import (
	"context"
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The resource inventory (package resources): what devices report, where
// browsers read it (GET /api/resources) and how they hear it changed.

var resourcesChangedEvent = browserevent.Define[browserevent.ResourcesChangedPayload](browserevent.ResourcesChanged, eventstream.Options{KeepsSnapshot: true})

// newResourceService wires the inventory over the backend.
func newResourceService(st Backend, hub *DaemonHub, stream eventstream.Publisher) *resources.Service {
	service := resources.NewService(st)
	service.Online = hub.HasConnection
	service.Changed = func(sourceID string) {
		// It carries no data, so it reaches every stream; readers filter.
		resourcesChangedEvent.Publish(stream, eventstream.Route{Everyone: true}, browserevent.ResourcesChangedPayload{SourceID: sourceID})
	}
	return service
}

// handleListResources lists the inventory of the devices the caller sees:
// ?type= and ?device= narrow it, ?includeGone=1 adds what disappeared.
func (s *Server) handleListResources(w http.ResponseWriter, r *http.Request) {
	list, err := s.visibleResources(r.Context(), actorFromContext(r.Context()), store.ResourceFilter{
		SourceID:    strings.TrimSpace(r.URL.Query().Get("device")),
		Type:        strings.TrimSpace(r.URL.Query().Get("type")),
		IncludeGone: r.URL.Query().Get("includeGone") == "1",
	})
	writeResult(w, list, err)
}

// visibleResources is the inventory narrowed to the devices the actor sees
// (the visibility of GET /api/devices); removed devices list nothing.
func (s *Server) visibleResources(ctx context.Context, actor Actor, filter store.ResourceFilter) (store.ResourceList, error) {
	view, err := s.visibilityFor(ctx, actor)
	if err != nil {
		return store.ResourceList{}, err
	}
	list, err := s.resources.List(ctx, filter)
	if err != nil {
		return store.ResourceList{}, err
	}
	sees := func(source store.ResourceSource) bool {
		return source.Kind == "device" && view.seesDevice(source.ID)
	}
	visible := store.ResourceList{Instances: []store.ResourceInstance{}, Sources: []store.ResourceSourceStatus{}}
	for _, instance := range list.Instances {
		if sees(instance.Source) {
			visible.Instances = append(visible.Instances, instance)
		}
	}
	for _, source := range list.Sources {
		if (filter.SourceID == "" || source.ID == filter.SourceID) && sees(store.ResourceSource{Kind: source.Kind, ID: source.ID}) {
			visible.Sources = append(visible.Sources, source)
		}
	}
	return visible, nil
}

// resourcesReported takes a worker's resources_report: its whole inventory.
// A report the server cannot keep is logged, not refused: the worker sends
// the next one when something changes or it reconnects.
func (c *daemonConnection) resourcesReported(ctx context.Context, envelope wsEnvelope) error {
	var report store.ResourcesReport
	if err := decodeWebSocketPayload(envelope.Payload, &report); err != nil {
		return err
	}
	deviceID, registration := c.registrationSnapshot()
	source := store.ResourceSource{Kind: "device", ID: deviceID, Label: registration.Device.Label}
	if _, err := c.hub.resources.Report(ctx, source, report); err != nil {
		log.Printf("daemon %s: resources report not kept: %v", deviceID, err)
	}
	c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	return nil
}

// resourcesOffline marks a disconnected device's inventory offline and
// starts the graces of the leases on it and of those its sessions hold.
func (h *DaemonHub) resourcesOffline(deviceID string) {
	if err := h.resources.SourceOffline(context.Background(), deviceID); err != nil {
		log.Printf("daemon %s: resources not marked offline: %v", deviceID, err)
	}
	if err := h.leases.DeviceDisconnected(context.Background(), deviceID); err != nil {
		log.Printf("daemon %s: resource leases not told it went away: %v", deviceID, err)
	}
}
