package eventstream

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type itemForTest struct {
	ID     string `json:"id"`
	Detail string `json:"detail,omitempty"`
}

var (
	itemAdded  = Define[itemForTest]("item_added", Options{})
	itemStream = Define[itemForTest]("item_streamed", Options{KeepsSnapshot: true})
)

// controlForTest names the stream's own messages; the reason says the gap.
var controlForTest = Control{
	Ready: Message{Type: "stream_ready", Payload: struct{}{}},
	Resync: func(gap Gap) Message {
		reasons := map[Gap]string{GapOverflow: "overflow", GapExpired: "expired", GapRestarted: "restarted", GapReauthorized: "reauthorized"}
		return Message{Type: "resync", Payload: map[string]string{"reason": reasons[gap]}}
	},
}

// reachForTest receives the workspaces it lists, all of them with "*".
type reachForTest struct {
	account    string
	workspaces []string
}

func (r reachForTest) Receives(workspaceID string) bool {
	for _, workspace := range r.workspaces {
		if workspace == "*" || workspace == workspaceID {
			return true
		}
	}
	return false
}

func (r reachForTest) Account() string { return r.account }

var everythingForTest = reachForTest{workspaces: []string{"*"}}

func inWorkspaceForTest(workspaceID string) Route { return Route{Workspace: workspaceID} }

// subscribeForTest opens a stream of reach holding up to buffer frames,
// resuming from nowhere; its ready message stays in its backlog.
func subscribeForTest(hub *Hub, reach Reach, buffer int) *Subscription {
	return resumeForTest(hub, reach, "", buffer)
}

// resumeForTest opens a stream of reach as a request resuming from
// lastEventID would.
func resumeForTest(hub *Hub, reach Reach, lastEventID string, buffer int) *Subscription {
	subscription, open := hub.subscribe(reach, lastEventID, buffer)
	if !open {
		panic("the hub shut down")
	}
	return subscription
}

// lostForTest reports whether the stream's buffer overflowed.
func lostForTest(subscription *Subscription) bool {
	return subscription.subscriber.lost.Load()
}

// streamsForTest is how many streams are open.
func streamsForTest(hub *Hub) int {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	return len(hub.subscribers)
}

// frameForTest splits one SSE frame into its id and decoded envelope.
func frameForTest(t *testing.T, frame []byte) (string, map[string]any) {
	t.Helper()
	id, data := "", ""
	for _, line := range strings.Split(strings.TrimSpace(string(frame)), "\n") {
		if value, ok := strings.CutPrefix(line, "id: "); ok {
			id = value
		}
		if value, ok := strings.CutPrefix(line, "data: "); ok {
			data = value
		}
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(data), &envelope); err != nil {
		t.Fatalf("decode frame %q: %v", frame, err)
	}
	return id, envelope
}

func TestStreamFramesCarryRisingIDs(t *testing.T) {
	hub := New(controlForTest)
	viewer := subscribeForTest(hub, everythingForTest, 4)
	itemAdded.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "iss_1"})
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_1"})
	first, _ := frameForTest(t, <-viewer.C)
	second, _ := frameForTest(t, <-viewer.C)
	if first != hub.epoch+"-1" || second != hub.epoch+"-2" {
		t.Fatalf("ids = %q, %q; want %s-1, %s-2", first, second, hub.epoch, hub.epoch)
	}
}

// A kind that keeps snapshots keeps the revision; every other message, and
// Invalidate, moves it on.
func TestRevisionFollowsWhatKindsKeep(t *testing.T) {
	hub := New(controlForTest)
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_1"})
	if hub.Revision() != 0 {
		t.Fatal("a kind keeping snapshots moved the revision")
	}
	itemAdded.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "iss_1"})
	hub.Invalidate()
	if hub.Revision() != 2 {
		t.Fatalf("revision = %d, want 2", hub.Revision())
	}
}

// A message reaches the streams whose reach receives its workspace; one of
// no workspace only those that receive that too; one for everyone every
// stream, also one without a reach.
func TestRoutesReachWhatEachStreamReceives(t *testing.T) {
	hub := New(controlForTest)
	member := subscribeForTest(hub, reachForTest{workspaces: []string{"ws_a"}}, 8)
	admin := subscribeForTest(hub, reachForTest{workspaces: []string{"*"}}, 8)
	nobody := subscribeForTest(hub, nil, 8)
	itemAdded.Publish(hub, inWorkspaceForTest("ws_a"), itemForTest{ID: "a"})
	itemAdded.Publish(hub, inWorkspaceForTest("ws_b"), itemForTest{ID: "b"})
	itemAdded.Publish(hub, Route{}, itemForTest{ID: "none"})
	itemAdded.Publish(hub, Route{Everyone: true}, itemForTest{ID: "all"})
	if len(member.C) != 2 || len(admin.C) != 4 || len(nobody.C) != 1 {
		t.Fatalf("delivered member %d, admin %d, nobody %d; want 2, 4, 1", len(member.C), len(admin.C), len(nobody.C))
	}
}

type streamReaderForTest struct {
	response *http.Response
	frames   chan string
}

func openStreamForTest(t *testing.T, ctx context.Context, url string, lastEventID string) *streamReaderForTest {
	t.Helper()
	return readStreamForTest(requestStreamForTest(t, ctx, url, lastEventID, http.Header{}))
}

// requestStreamForTest opens a stream without reading it.
func requestStreamForTest(t *testing.T, ctx context.Context, url string, lastEventID string, header http.Header) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header = header
	if lastEventID != "" {
		request.Header.Set("Last-Event-ID", lastEventID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

// readStreamForTest reads the stream's frames as they arrive.
func readStreamForTest(response *http.Response) *streamReaderForTest {
	reader := &streamReaderForTest{response: response, frames: make(chan string, 512)}
	go func() {
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 0, 1<<16), 1<<22)
		var frame strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if frame.Len() > 0 {
					reader.frames <- frame.String()
					frame.Reset()
				}
				continue
			}
			if strings.HasPrefix(line, ":") || strings.HasPrefix(line, "retry:") {
				continue
			}
			frame.WriteString(line + "\n")
		}
		close(reader.frames)
	}()
	return reader
}

func (r *streamReaderForTest) next(t *testing.T) (string, map[string]any) {
	t.Helper()
	select {
	case frame, ok := <-r.frames:
		if !ok {
			t.Fatal("stream ended")
		}
		return frameForTest(t, []byte(frame))
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for a stream frame")
	}
	return "", nil
}

func streamServerForTest(hub *Hub) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.Serve(w, r, everythingForTest)
	}))
}

// A browser reconnecting with Last-Event-ID gets exactly what it missed.
func TestStreamResumesFromLastEventID(t *testing.T) {
	hub := New(controlForTest)
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for index := 1; index <= 5; index++ {
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: fmt.Sprintf("evt_%d", index)})
	}
	stream := openStreamForTest(t, ctx, server.URL, hub.epoch+"-2")
	for _, want := range []string{"evt_3", "evt_4", "evt_5"} {
		id, envelope := stream.next(t)
		payload := envelope["payload"].(map[string]any)
		if payload["id"] != want || !strings.HasPrefix(id, hub.epoch+"-") {
			t.Fatalf("replayed %s %v, want %s", id, payload, want)
		}
	}
	// Live events follow the replay.
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_6"})
	if id, envelope := stream.next(t); envelope["payload"].(map[string]any)["id"] != "evt_6" || id != hub.epoch+"-6" {
		t.Fatalf("live event = %s %v, want evt_6", id, envelope)
	}
}

// When the missed events are gone (another server process, or older than
// the ring), the stream says so instead of resuming with a gap.
func TestStreamAsksForResyncWhenItCannotResume(t *testing.T) {
	hub := New(controlForTest)
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for index := 0; index < ringEntries+10; index++ {
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: fmt.Sprintf("evt_%d", index)})
	}
	for _, test := range []struct {
		lastEventID string
		reason      string
	}{
		{"otherprocess-3", "restarted"},
		{hub.epoch + "-3", "expired"},
		{"garbage", "restarted"},
	} {
		stream := openStreamForTest(t, ctx, server.URL, test.lastEventID)
		id, envelope := stream.next(t)
		payload, _ := envelope["payload"].(map[string]any)
		if envelope["type"] != "resync" || payload["reason"] != test.reason {
			t.Fatalf("resume from %s = %v, want resync %s", test.lastEventID, envelope, test.reason)
		}
		if id != fmt.Sprintf("%s-%d", hub.epoch, ringEntries+10) {
			t.Fatalf("resync id = %s, want the newest event", id)
		}
	}
	// Up to date: nothing to replay and no resync.
	stream := openStreamForTest(t, ctx, server.URL, fmt.Sprintf("%s-%d", hub.epoch, ringEntries+10))
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_live"})
	if _, envelope := stream.next(t); envelope["type"] != "item_streamed" {
		t.Fatalf("up-to-date resume = %v, want the live event", envelope)
	}
}

// A stream opened with nowhere to resume from gets a place to resume from
// at once: a connection that drops before any event resumes.
func TestFreshStreamStartsWithItsResumePoint(t *testing.T) {
	hub := New(controlForTest)
	itemAdded.Publish(hub, inWorkspaceForTest("ws_ready"), itemForTest{ID: "chat_1"})
	backlog := subscribeForTest(hub, everythingForTest, 8).Backlog()
	if len(backlog) != 1 {
		t.Fatalf("a fresh stream starts with %d frames, want its ready message", len(backlog))
	}
	id, envelope := frameForTest(t, backlog[0])
	if envelope["type"] != "stream_ready" || id != hub.epoch+"-1" {
		t.Fatalf("ready frame = %s %v, want the newest event's id", id, envelope)
	}
	itemAdded.Publish(hub, inWorkspaceForTest("ws_ready"), itemForTest{ID: "chat_2"})
	replay := resumeForTest(hub, everythingForTest, id, 8).Backlog()
	if len(replay) != 1 {
		t.Fatalf("resuming from the ready id replays %d events, want the one after it", len(replay))
	}
}

// A change of an account's access ends its streams; one resuming from an
// event before the change is told to resync (the replay would not show what
// the new access adds or takes away), and after that resumes normally.
// Other accounts resume as before.
func TestStreamResumingAcrossAnAccessChangeResyncs(t *testing.T) {
	hub := New(controlForTest)
	bobReach := reachForTest{account: "usr_bob", workspaces: []string{"ws_a"}}
	carolReach := reachForTest{account: "usr_carol", workspaces: []string{"ws_a"}}
	bob := subscribeForTest(hub, bobReach, 8)
	carol := subscribeForTest(hub, carolReach, 8)
	itemAdded.Publish(hub, inWorkspaceForTest("ws_a"), itemForTest{ID: "1"})
	seen, _ := frameForTest(t, <-bob.C)
	<-carol.C

	hub.Reauthorize("usr_bob")
	select {
	case <-bob.Done():
	default:
		t.Fatal("bob's stream did not end")
	}
	itemAdded.Publish(hub, inWorkspaceForTest("ws_a"), itemForTest{ID: "2"})
	if len(bob.C) != 0 {
		t.Fatal("an ended stream was delivered an event published after the access change")
	}
	if len(carol.C) != 1 {
		t.Fatalf("carol holds %d events, want the live one", len(carol.C))
	}

	backlog := resumeForTest(hub, bobReach, seen, 8).Backlog()
	if len(backlog) != 1 {
		t.Fatalf("bob resumed with %d frames, want one resync", len(backlog))
	}
	id, envelope := frameForTest(t, backlog[0])
	if envelope["type"] != "resync" || envelope["payload"].(map[string]any)["reason"] != "reauthorized" {
		t.Fatalf("bob resumed with %v, want resync reauthorized", envelope)
	}
	if id != fmt.Sprintf("%s-%d", hub.epoch, hub.seq) {
		t.Fatalf("resync id = %s, want the newest event", id)
	}
	if again := resumeForTest(hub, bobReach, id, 8).Backlog(); len(again) != 0 {
		t.Fatalf("resuming after the resync = %d frames, want none", len(again))
	}
	if replay := resumeForTest(hub, carolReach, seen, 8).Backlog(); len(replay) != 1 {
		t.Fatalf("carol resumed with %d frames, want the one event she missed", len(replay))
	} else if _, envelope := frameForTest(t, replay[0]); envelope["type"] != "item_added" {
		t.Fatalf("carol resumed with %v", envelope)
	}
}

// A subscriber whose buffer overflows is told to resync once it has written
// what it holds, and receives events again afterwards.
func TestOverflowingSubscriberGetsResync(t *testing.T) {
	hub := New(controlForTest)
	viewer := subscribeForTest(hub, everythingForTest, 2)
	for index := 0; index < 5; index++ {
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: fmt.Sprintf("evt_%d", index)})
	}
	if !lostForTest(viewer) || len(viewer.C) != 2 {
		t.Fatalf("lost=%v buffered=%d, want a lost subscriber holding 2", lostForTest(viewer), len(viewer.C))
	}
	<-viewer.C
	if _, early := viewer.Resync(); early {
		t.Fatal("resync before the stream wrote what it holds")
	}
	<-viewer.C
	resync, ok := viewer.Resync()
	if !ok {
		t.Fatal("no resync once the stream wrote what it holds")
	}
	id, envelope := frameForTest(t, resync)
	if envelope["type"] != "resync" || envelope["payload"].(map[string]any)["reason"] != "overflow" || id != hub.epoch+"-5" {
		t.Fatalf("resync = %s %v", id, envelope)
	}
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_after"})
	if _, envelope := frameForTest(t, <-viewer.C); envelope["payload"].(map[string]any)["id"] != "evt_after" {
		t.Fatalf("after resync = %v", envelope)
	}
}

// End to end over HTTP: a stream that cannot keep up sees resync on the
// wire, after what it held, and is delivered messages again after it.
func TestSlowStreamSeesResync(t *testing.T) {
	hub := New(controlForTest)
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Uncompressed: what is compressed is not what this tests, and
	// compressing megabytes is slow under the race detector.
	header := http.Header{}
	header.Set("Accept-Encoding", "identity")
	response := requestStreamForTest(t, ctx, server.URL, "", header)
	writer := onlySubscriberForTest(t, hub)
	// The browser reads nothing yet: once the socket is full, the writer
	// stops taking frames and the stream's buffer overflows.
	detail := strings.Repeat("x", 4<<10)
	published := 0
	for ; !writer.lost.Load(); published++ {
		if published == 1<<16 {
			t.Fatal("the stream never fell behind a browser that reads nothing")
		}
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: fmt.Sprintf("evt_%d", published), Detail: detail})
	}
	stream := readStreamForTest(response)
	if _, envelope := stream.next(t); envelope["type"] != "stream_ready" {
		t.Fatalf("first frame = %v, want the ready message", envelope)
	}
	for held := 0; ; held++ {
		_, envelope := stream.next(t)
		if envelope["type"] == "resync" {
			if held == 0 || held >= published {
				t.Fatalf("resync after %d of %d frames, want it after what the stream held", held, published)
			}
			break
		}
		if want := fmt.Sprintf("evt_%d", held); envelope["payload"].(map[string]any)["id"] != want {
			t.Fatalf("frame %d = %v, want %s", held, envelope["payload"].(map[string]any)["id"], want)
		}
	}
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_after"})
	if _, envelope := stream.next(t); envelope["payload"].(map[string]any)["id"] != "evt_after" {
		t.Fatalf("after the resync = %v, want the next message", envelope)
	}
}

// onlySubscriberForTest is the hub's one open stream.
func onlySubscriberForTest(t *testing.T, hub *Hub) *subscriber {
	t.Helper()
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	if len(hub.subscribers) != 1 {
		t.Fatalf("%d open streams, want one", len(hub.subscribers))
	}
	for subscriber := range hub.subscribers {
		return subscriber
	}
	return nil
}

func TestRingStaysWithinItsBounds(t *testing.T) {
	hub := New(controlForTest)
	detail := strings.Repeat("y", 1<<20)
	for index := 0; index < 20; index++ {
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: fmt.Sprintf("evt_%d", index), Detail: detail})
	}
	if hub.ringBytes > ringBytes || len(hub.ring) == 0 || hub.ring[len(hub.ring)-1].seq != 20 {
		t.Fatalf("ring holds %d bytes in %d events", hub.ringBytes, len(hub.ring))
	}
}

// Messages are never lost to a slow stream: a subscriber that overflowed
// is told to resync, and a reconnect with Last-Event-ID replays them.
func TestCompletionSurvivesAnOverflowingStream(t *testing.T) {
	hub := New(controlForTest)
	viewer := subscribeForTest(hub, everythingForTest, 1)
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_seen"})
	seenID, _ := frameForTest(t, <-viewer.C)
	itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_buffered"})
	itemAdded.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "sess_1", Detail: "done"})
	if !lostForTest(viewer) {
		t.Fatal("the completion fit a full buffer")
	}
	<-viewer.C
	if resync, _ := viewer.Resync(); resync == nil {
		t.Fatal("no resync after the overflow")
	} else if _, envelope := frameForTest(t, resync); envelope["type"] != "resync" {
		t.Fatalf("overflowed stream got %v, want resync", envelope)
	}

	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := openStreamForTest(t, ctx, server.URL, seenID)
	stream.next(t)
	if _, envelope := stream.next(t); envelope["type"] != "item_added" {
		t.Fatalf("resume replayed %v, want the completion", envelope)
	}
}

// Shutdown releases open streams and refuses new ones.
func TestShutdownEndsStreams(t *testing.T) {
	hub := New(controlForTest)
	request := httptest.NewRequest(http.MethodGet, "/events", nil)
	served := make(chan struct{})
	go func() {
		defer close(served)
		hub.Serve(httptest.NewRecorder(), request, everythingForTest)
	}()
	for deadline := time.Now().Add(2 * time.Second); streamsForTest(hub) != 1; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the stream never opened")
		}
	}
	hub.Shutdown()
	hub.Shutdown()
	select {
	case <-served:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream did not end at shutdown")
	}
	refused := httptest.NewRecorder()
	hub.Serve(refused, request, everythingForTest)
	if refused.Code != http.StatusServiceUnavailable || streamsForTest(hub) != 0 {
		t.Fatalf("after shutdown: %d with %d streams", refused.Code, streamsForTest(hub))
	}
}
