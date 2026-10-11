package httpapi

import (
	"sort"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
)

var foundryDataChangedEvent = browserevent.Define[browserevent.FoundryDataChangedPayload](browserevent.FoundryDataChanged, eventstream.Options{})

// foundryDataChangeInterval is the most often foundry_data_changed goes out
// for one workspace (or globally): the first change of a burst is announced
// at once and the rest once at the end of the interval, with every field
// they touched, so the last change is never left unannounced.
var foundryDataChangeInterval = time.Second

// dataChanges announces writes to what GET /api/foundry-data serves that
// no other event carries (foundry_data_changed): clients read the named
// fields again. Cached snapshots are out of date at once; the announcements
// of one workspace (or of every workspace's view) are throttled.
type dataChanges struct {
	stream   snapshotStream
	throttle *eventstream.Throttle[string, changedFields]
}

// snapshotStream is a stream that also puts cached snapshots out of date
// at once, before a change is announced.
type snapshotStream interface {
	eventstream.Publisher
	Invalidate()
}

func newDataChanges(stream snapshotStream) *dataChanges {
	changes := &dataChanges{stream: stream}
	changes.throttle = eventstream.NewThrottle(eventstream.ThrottleOptions[string, changedFields]{
		Window:  func() time.Duration { return foundryDataChangeInterval },
		Leading: true,
		Merge:   changedFields.with,
		Emit:    changes.publish,
	})
	return changes
}

// changed announces a committed change to the named foundry-data fields
// for workspaceID ("" for every workspace); no field names any.
func (d *dataChanges) changed(workspaceID string, resources ...string) {
	d.stream.Invalidate()
	d.throttle.Add(workspaceID, fieldsOf(resources))
}

// publish sends one announcement. A global one carries no data, so it
// reaches every stream.
func (d *dataChanges) publish(workspaceID string, fields changedFields) {
	foundryDataChangedEvent.Publish(d.stream, eventstream.Route{Workspace: workspaceID, Everyone: workspaceID == ""},
		browserevent.FoundryDataChangedPayload{WorkspaceID: workspaceID, Resources: fields.list()})
}

// changedFields is the foundry-data fields changes touched; nil stands for
// any field.
type changedFields map[string]bool

func fieldsOf(resources []string) changedFields {
	if len(resources) == 0 {
		return nil
	}
	fields := changedFields{}
	for _, resource := range resources {
		fields[resource] = true
	}
	return fields
}

// with is the fields both changes touched.
func (f changedFields) with(next changedFields) changedFields {
	if f == nil || next == nil {
		return nil
	}
	for name := range next {
		f[name] = true
	}
	return f
}

// list names the fields in order; nil for any.
func (f changedFields) list() []string {
	if f == nil {
		return nil
	}
	names := make([]string, 0, len(f))
	for name := range f {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
