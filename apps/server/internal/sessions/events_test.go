package sessions

import (
	"context"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type everyWorkspace struct{}

func (everyWorkspace) Receives(string) bool { return true }
func (everyWorkspace) Account() string      { return "" }

// orderObserver notes, under its name, what it is told and how many
// frames the viewer held by then.
type orderObserver struct {
	name   string
	held   func() int
	told   *[]string
	events *[]string
}

func (o orderObserver) SessionChanged(_ context.Context, change Change, session store.AgentSession) {
	if len(session.Events) != 0 || session.Input.ImportedContext != "" {
		*o.told = append(*o.told, o.name+" got the transcript")
	}
	*o.told = append(*o.told, o.name+" "+change.Event().Name()+" "+session.ID)
	if o.held() == 0 {
		*o.told = append(*o.told, o.name+" before the viewers")
	}
}

func (o orderObserver) SessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	*o.events = append(*o.events, o.name+" "+event.ID)
}

func (o orderObserver) SessionEndReported(_ context.Context, session store.AgentSession) {
	*o.told = append(*o.told, o.name+" end "+session.ID)
}

// What changes a session's side panel (an event with a state key, a change
// of its status) tells its viewers the panel once, as the server derives
// it; the rest of the transcript does not.
func TestPanelChangesAreToldOnce(t *testing.T) {
	previous := PanelCoalesce
	PanelCoalesce = 20 * time.Millisecond
	t.Cleanup(func() { PanelCoalesce = previous })
	hub := eventstream.New(eventstream.Control{})
	viewer, open := hub.Subscribe(everyWorkspace{}, "")
	if !open {
		t.Fatal("the stream is closed")
	}
	events := NewEvents(hub)
	var reads atomic.Int32
	events.Panel = func(_ context.Context, sessionID string) (store.AgentSessionPanel, error) {
		reads.Add(1)
		return store.AgentSessionPanel{Busy: true, Timers: []store.AgentSessionPanelTimer{}}, nil
	}
	ctx := context.Background()
	events.Recorded(ctx, "ws_1", store.AgentSessionEvent{ID: "evt_answer", SessionID: "sess_1", Label: store.EventLabelResponseStream})
	snapshot := []store.AgentBackgroundTask{}
	for _, id := range []string{"evt_bg_1", "evt_bg_2"} {
		events.Recorded(ctx, "ws_1", store.AgentSessionEvent{ID: id, SessionID: "sess_1", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &snapshot}})
	}
	events.Changed(ctx, Completed, store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1", Status: "completed"})
	deadline := time.After(2 * time.Second)
	var panels int
	for panels == 0 {
		select {
		case frame := <-viewer.C:
			if strings.Contains(string(frame), `"agent_session_panel"`) {
				panels++
				if !strings.Contains(string(frame), `"sessionId":"sess_1"`) || !strings.Contains(string(frame), `"busy":true`) {
					t.Fatalf("panel frame = %s", frame)
				}
			}
		case <-deadline:
			t.Fatal("no agent_session_panel within 2s")
		}
	}
	time.Sleep(5 * PanelCoalesce)
	if got := reads.Load(); got != 1 {
		t.Fatalf("panel read %d times; want once for the gathered changes", got)
	}
}

// Observers react in the order they were added, kind by kind, each after
// the session's viewers were told, and get the session without its
// transcript; Observing lists them in that order.
func TestObserversReactInOrderAfterViewers(t *testing.T) {
	hub := eventstream.New(eventstream.Control{})
	viewer, open := hub.Subscribe(everyWorkspace{}, "")
	if !open {
		t.Fatal("the stream is closed")
	}
	events := NewEvents(hub)
	var told, recorded []string
	held := func() int { return len(viewer.C) }
	first := orderObserver{name: "first", held: held, told: &told, events: &recorded}
	second := orderObserver{name: "second", held: held, told: &told, events: &recorded}
	events.Observe(Observers{Changes: []ChangeObserver{first}, Events: []EventObserver{second}})
	events.Observe(Observers{Changes: []ChangeObserver{second}, Events: []EventObserver{first}, Ends: []EndObserver{second}})
	if got := len(events.Observing().Changes); got != 2 {
		t.Fatalf("observing %d changes, want 2", got)
	}

	ctx := context.Background()
	session := store.AgentSession{ID: "sess_1", WorkspaceID: "ws_1", Status: "completed",
		Events: []store.AgentSessionEvent{{ID: "evt_1"}}, Input: store.SessionInput{ImportedContext: "earlier turns"}}
	events.Changed(ctx, Completed, session)
	events.Recorded(ctx, session.WorkspaceID, store.AgentSessionEvent{ID: "evt_2", SessionID: session.ID})
	events.EndReported(ctx, session)

	want := []string{"first agent_session_completed sess_1", "second agent_session_completed sess_1", "second end sess_1"}
	if !reflect.DeepEqual(told, want) {
		t.Fatalf("observers were told %v, want %v", told, want)
	}
	if want := []string{"second evt_2", "first evt_2"}; !reflect.DeepEqual(recorded, want) {
		t.Fatalf("observers recorded %v, want %v", recorded, want)
	}
}
