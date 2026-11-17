package channels_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// openLarkEvents is the feed the bundled OpenLark extension declares.
func openLarkEvents(t *testing.T) store.ConnectorEventsSpec {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "extensions", "open-lark", "foundry-extension.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Connectors []store.ConnectorDescriptor `json:"connectors"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	events := manifest.Connectors[0].ServerHeld.Events
	if events == nil {
		t.Fatal("the OpenLark extension declares no events")
	}
	return *events
}

// A change as OpenLark's GET /agent/v1/changes returns it (open-lark
// src/server/agent-plane/change-view.ts, context/message-items.ts).
func larkChange(id, feed, kind, text string, atMe, mine bool) map[string]any {
	signals := map[string]any{}
	if atMe {
		signals["atMe"] = true
	}
	if mine {
		signals["mine"] = true
	}
	return map[string]any{
		"seq": 7, "at": 1794500000000, "kind": "message", "op": "new", "feedId": feed, "id": id,
		"item": map[string]any{
			"id": "msg:" + id, "source": "chats", "kind": "message", "time": 1794500000000,
			"author": map[string]any{"id": "ou_peer", "name": "张三"},
			"where":  map[string]any{"id": feed, "name": "项目群", "kind": kind},
			"text":   text, "signals": signals,
			"thread": map[string]any{"id": "th_1", "reply": true},
		},
	}
}

func decoded(t *testing.T, value any) any {
	t.Helper()
	raw, _ := json.Marshal(value)
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOpenLarkChangeMapsToAGenericEnvelope(t *testing.T) {
	spec := openLarkEvents(t)
	envelope, skip, err := channels.MapItem(spec.Envelope, decoded(t, larkChange("7312", "oc_g", "group", "@邓灿文 /fd 看下这个", true, false)))
	if err != nil || skip {
		t.Fatalf("map: %v skip=%v", err, skip)
	}
	if envelope.ID != "new:7312" || envelope.MessageID != "7312" || envelope.Kind != "message" || envelope.Op != "new" {
		t.Fatalf("ids: %+v", envelope)
	}
	if envelope.Conversation != (store.MessageEnvelopeConversation{ID: "oc_g", Kind: "group", Name: "项目群"}) {
		t.Fatalf("conversation: %+v", envelope.Conversation)
	}
	if !envelope.MentionsMe || envelope.Sender.IsSelf || envelope.Sender.Name != "张三" || envelope.Thread.ID != "th_1" || !envelope.Thread.IsReply {
		t.Fatalf("envelope: %+v", envelope)
	}
	if envelope.OccurredAt != "2026-11-12T16:13:20Z" {
		t.Fatalf("occurredAt %q", envelope.OccurredAt)
	}
	quoted := larkChange("7313", "oc_g", "group", "这个呢", true, false)
	quoted["item"].(map[string]any)["refs"] = []any{map[string]any{"rel": "parent", "id": "msg:7300"}}
	if envelope, _, _ := channels.MapItem(spec.Envelope, decoded(t, quoted)); envelope.Attributes["replyTo"] != "7300" {
		t.Fatalf("a reply maps its parent: %+v", envelope.Attributes)
	}
	direct, _, _ := channels.MapItem(spec.Envelope, decoded(t, larkChange("1", "oc_d", "p2p", "hi", false, true)))
	if direct.Conversation.Kind != "direct" || !direct.Sender.IsSelf || direct.MentionsMe {
		t.Fatalf("direct: %+v", direct)
	}
	gone := larkChange("2", "oc_d", "p2p", "", false, false)
	delete(gone, "item")
	gone["gone"] = true
	if _, skip, _ := channels.MapItem(spec.Envelope, decoded(t, gone)); !skip {
		t.Fatal("a recalled message is skipped")
	}
}

func rule(id string, kinds []string, mentionsMe, fromSelf string, prefixes ...string) store.MessageChannelRule {
	return store.MessageChannelRule{ID: id, Enabled: true, ConversationKinds: kinds, MentionsMe: mentionsMe, FromSelf: fromSelf, TextPrefixes: prefixes}
}

func TestRulesKeepDirectAndMentionedMessagesWithThePrefix(t *testing.T) {
	rules := channels.Rules{
		rule("dm", []string{"direct"}, "any", "no", "/fd"),
		rule("group", []string{"group"}, "yes", "no", "/fd"),
	}
	envelope := func(kind string, atMe, mine bool, text string) store.MessageEnvelope {
		return store.MessageEnvelope{ID: "x", Conversation: store.MessageEnvelopeConversation{ID: "c", Kind: kind},
			Sender: store.MessageEnvelopeSender{ID: "s", IsSelf: mine}, MentionsMe: atMe, Text: text}
	}
	cases := []struct {
		name string
		in   store.MessageEnvelope
		keep string
	}{
		{"direct with prefix", envelope("direct", false, false, "/fd 帮我看下"), "dm"},
		{"direct prefix in another case", envelope("direct", false, false, "/FD hi"), "dm"},
		{"direct without prefix", envelope("direct", false, false, "在吗"), ""},
		{"prefix not at the start", envelope("direct", false, false, "hello /fd"), ""},
		{"my own direct message", envelope("direct", false, true, "/fd x"), ""},
		{"group mention with prefix", envelope("group", true, false, "@邓灿文 /fd 看下"), "group"},
		{"group, two mentions", envelope("group", true, false, "@邓灿文 @李四 /fd 看下"), "group"},
		{"trigger glued to Chinese text", envelope("direct", false, false, "/fd帮我看下"), "dm"},
		{"trigger then full-width comma", envelope("direct", false, false, "/fd，看下"), "dm"},
		{"trigger alone", envelope("direct", false, false, "/fd"), "dm"},
		{"trigger running on into a longer word", envelope("direct", false, false, "/fdx 看下"), ""},
		{"a word between the mention and the trigger", envelope("group", true, false, "@邓灿文 hello /fd"), ""},
		{"group prefix without mention", envelope("group", false, false, "/fd 看下"), ""},
		{"group mention without prefix", envelope("group", true, false, "@邓灿文 看下"), ""},
	}
	for _, c := range cases {
		decision := rules.Decide(c.in)
		if (c.keep != "") != decision.Keep || decision.Rule != c.keep {
			t.Errorf("%s: %+v", c.name, decision)
		}
	}
	if decision := (channels.Rules{}).Decide(envelope("direct", false, false, "/fd")); decision.Keep || decision.Reason != "no_rules" {
		t.Fatalf("no rules keeps nothing: %+v", decision)
	}
}

// feed is a fake event feed: what each poll answers, what its reads answer,
// and what it was asked.
type feed struct {
	mu      sync.Mutex
	answers []feedAnswer
	reads   map[string]feedAnswer
	asked   []url.Values
	readAt  []string
}

type feedAnswer struct {
	status int
	body   any
}

func (f *feed) Get(ctx context.Context, path string, query url.Values) (int, []byte, http.Header, error) {
	if path != "/agent/v1/changes" {
		f.mu.Lock()
		f.readAt = append(f.readAt, path)
		answer, ok := f.reads[path]
		f.mu.Unlock()
		if !ok {
			raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "NOT_FOUND", "message": "no such read"}})
			return http.StatusNotFound, raw, http.Header{}, nil
		}
		raw, _ := json.Marshal(answer.body)
		return answer.status, raw, http.Header{}, nil
	}
	f.mu.Lock()
	f.asked = append(f.asked, query)
	if len(f.answers) == 0 {
		f.mu.Unlock()
		<-ctx.Done()
		return 0, nil, nil, ctx.Err()
	}
	answer := f.answers[0]
	f.answers = f.answers[1:]
	f.mu.Unlock()
	raw, _ := json.Marshal(answer.body)
	return answer.status, raw, http.Header{}, nil
}

func (f *feed) queries() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]url.Values(nil), f.asked...)
}

// inbox records the turns handed to the assistant.
type inbox struct {
	mu      sync.Mutex
	entries map[string]channels.InboxStatus
	texts   map[string]string
	keys    map[string]string
	inboxes map[string]string
}

func newInbox() *inbox {
	return &inbox{entries: map[string]channels.InboxStatus{}, texts: map[string]string{}, keys: map[string]string{}, inboxes: map[string]string{}}
}

func (i *inbox) Deliver(ctx context.Context, channel store.MessageChannelRecord, turn channels.Turn) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	id := "inbox_" + turn.MessageID
	if _, ok := i.entries[id]; !ok {
		i.entries[id] = channels.InboxStatus{Status: "pending"}
	}
	i.texts[id], i.keys[id], i.inboxes[id] = turn.Text, turn.SessionKey, turn.InboxChannel
	return id, nil
}

func (i *inbox) Status(ctx context.Context, assistantID, inboxID string) (channels.InboxStatus, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	status, ok := i.entries[inboxID]
	if !ok {
		return status, store.ErrNotFound
	}
	return status, nil
}

func (i *inbox) set(id string, status channels.InboxStatus) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.entries[id] = status
}

func (i *inbox) all() map[string]string {
	i.mu.Lock()
	defer i.mu.Unlock()
	out := map[string]string{}
	for id, text := range i.texts {
		out[id] = text
	}
	return out
}

type ackCall struct {
	add bool
	ids []string
}

type fixture struct {
	mu           sync.Mutex
	st           *sqlitestore.Store
	feed         *feed
	inbox        *inbox
	runner       *channels.Runner
	now          time.Time
	told         []string
	channel      store.MessageChannelRecord
	sessions     map[string]channels.SessionState
	ownWrites    map[string]bool
	ownWritesErr error
	acks         []ackCall
	ackErr       error
	working      map[string]bool
	contexts     []contextCall
}

// contextCall is one context update steered into a session.
type contextCall struct {
	sessionID string
	turn      channels.Turn
}

func (f *fixture) contextTexts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.contexts))
	for _, call := range f.contexts {
		out = append(out, call.turn.Text)
	}
	return out
}

func newFixture(t *testing.T, limits store.MessageChannelLimits) *fixture {
	t.Helper()
	st, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, feed: &feed{reads: map[string]feedAnswer{}}, inbox: newInbox(), now: time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC),
		sessions: map[string]channels.SessionState{}, ownWrites: map[string]bool{}, working: map[string]bool{}}
	spec := openLarkEvents(t)
	f.runner = channels.NewRunner(channels.Ports{
		Store: st,
		Open: func(ctx context.Context, channel store.MessageChannelRecord) (channels.Source, error) {
			return channels.LongPoll{Spec: spec, Upstream: f.feed}, nil
		},
		Inbox: f.inbox,
		ReplyCommand: func(ctx context.Context, channel store.MessageChannelRecord, kind string) string {
			if kind == "group" {
				return "olk im reply {message.id} --thread"
			}
			return "olk im reply {message.id}"
		},
		OwnWrites: func(ctx context.Context, channel store.MessageChannelRecord) (map[string]bool, error) {
			return f.ownWrites, f.ownWritesErr
		},
		Ack: func(ctx context.Context, channel store.MessageChannelRecord, add bool, ids []string) error {
			f.acks = append(f.acks, ackCall{add: add, ids: append([]string(nil), ids...)})
			return f.ackErr
		},
		Tell: func(ctx context.Context, channel store.MessageChannelRecord, key, title, detail string) {
			f.told = append(f.told, key)
		},
		Now: func() time.Time { return f.now },
		Session: func(ctx context.Context, id string) (channels.SessionState, bool) {
			state, ok := f.sessions[id]
			return state, ok
		},
		Working: func(ctx context.Context, id string) (bool, error) {
			return f.working[id], nil
		},
		Context: func(ctx context.Context, channel store.MessageChannelRecord, sessionID string, turn channels.Turn) (bool, error) {
			if !f.working[sessionID] {
				return false, nil
			}
			f.mu.Lock()
			f.contexts = append(f.contexts, contextCall{sessionID: sessionID, turn: turn})
			f.mu.Unlock()
			return true, nil
		},
	})
	f.channel = store.MessageChannelRecord{UserID: "u1", MessageChannel: store.MessageChannel{
		ID: "mch_test", AssistantID: "asst_1", Name: "飞书 /fd", Enabled: true,
		Source:     store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Filters:    store.MessageChannelFilters{Rules: []store.MessageChannelRule{rule("dm", []string{"direct"}, "any", "no", "/fd"), rule("group", []string{"group"}, "yes", "no", "/fd")}},
		SessionKey: "conversation", Limits: limits, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := st.SaveMessageChannel(context.Background(), f.channel); err != nil {
		t.Fatal(err)
	}
	return f
}

func changes(cursor string, items ...map[string]any) feedAnswer {
	list := make([]any, 0, len(items))
	for _, item := range items {
		list = append(list, item)
	}
	return feedAnswer{status: 200, body: map[string]any{"cursor": cursor, "more": false, "changes": list}}
}

// poll runs the channel's loop until the fake feed has no answers left.
func (f *fixture) poll(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.runner.Run(ctx)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		f.feed.mu.Lock()
		left := len(f.feed.answers)
		f.feed.mu.Unlock()
		if left == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the runner did not read the feed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Let the last batch be recorded.
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-done
}

func (f *fixture) records(t *testing.T, statuses ...string) []store.MessageChannelDeliveryRecord {
	t.Helper()
	records, err := f.st.ListMessageChannelDeliveries(context.Background(), f.channel.ID, statuses, 100)
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func TestRunnerFiltersRecordsOnceAndResumesFromItsCursor(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	keep := larkChange("m1", "oc_dm", "p2p", "/fd 帮我看下", false, false)
	drop := larkChange("m2", "oc_g", "group", "大家好", false, false)
	f.feed.answers = []feedAnswer{
		changes("c1", keep, drop),
		changes("c2", keep), // the same message again: no second record
	}
	f.poll(t)
	queries := f.feed.queries()
	if queries[0].Has("since") || queries[0].Get("wait") != "25" || queries[0].Get("kinds") != "message" {
		t.Fatalf("first poll starts from now: %v", queries[0])
	}
	if queries[1].Get("since") != "c1" || queries[2].Get("since") != "c2" {
		t.Fatalf("polls follow the cursor: %v", queries)
	}
	queued := f.records(t, store.MessageDeliveryQueued)
	dropped := f.records(t, store.MessageDeliveryDropped)
	if len(queued) != 1 || queued[0].Envelope.MessageID != "m1" || queued[0].Rule != "dm" || queued[0].SessionKey != "c:oc_dm" {
		t.Fatalf("queued: %+v", queued)
	}
	if len(dropped) != 1 || dropped[0].Envelope.Text != "" || dropped[0].Reason != "no_rule_matched" || dropped[0].Envelope.Conversation.Name != "项目群" {
		t.Fatalf("dropped keeps metadata, no text: %+v", dropped)
	}
	runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID)
	if runtime.Cursor != "c2" || runtime.State != channels.StateRunning {
		t.Fatalf("runtime: %+v", runtime)
	}
	// A restart resumes from the stored cursor.
	f.feed.answers = []feedAnswer{changes("c3")}
	f.poll(t)
	if got := f.feed.queries(); got[len(got)-2].Get("since") != "c2" {
		t.Fatalf("resume: %v", got)
	}
}

// OpenLark reports a message again as "thread" once someone replies to it
// and as "update" when it is edited; neither may start another turn.
func TestRunnerHandsOverOnlyNewMessages(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	posted := larkChange("m1", "oc_dm", "p2p", "/fd hi", false, false)
	threaded := larkChange("m1", "oc_dm", "p2p", "/fd hi", false, false)
	threaded["op"] = "thread"
	edited := larkChange("m1", "oc_dm", "p2p", "/fd hi again", false, false)
	edited["op"] = "update"
	f.feed.answers = []feedAnswer{changes("c1", posted), changes("c2", threaded, edited)}
	f.poll(t)
	all := f.records(t)
	if len(all) != 1 || all[0].Envelope.ID != "new:m1" || all[0].Status != store.MessageDeliveryQueued {
		t.Fatalf("only the posted message is recorded: %+v", all)
	}
	runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID)
	if runtime.Cursor != "c2" {
		t.Fatalf("the cursor moves past skipped changes: %+v", runtime)
	}
}

func TestRunnerTakesTheResetCursorAfterAGapAndTellsThePerson(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	_ = f.st.SaveMessageChannelRuntime(context.Background(), store.MessageChannelRuntime{ChannelID: f.channel.ID, Cursor: "old"})
	f.feed.answers = []feedAnswer{
		{status: 410, body: map[string]any{"error": map[string]any{"code": "CHANGES_CURSOR_GONE", "reset": "r9"}}},
		changes("r10"),
	}
	f.poll(t)
	queries := f.feed.queries()
	if queries[0].Get("since") != "old" || queries[1].Get("since") != "r9" {
		t.Fatalf("after the gap the poll continues at reset: %v", queries)
	}
	runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID)
	if runtime.GapAt == "" || len(f.told) != 1 || f.told[0] != "gap" {
		t.Fatalf("gap recorded and told: %+v %v", runtime, f.told)
	}
}

func TestRunnerHoldsMessagesOverTheLimitAndReleasesThem(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 1, PerDay: 100, Concurrency: 3})
	f.feed.answers = []feedAnswer{changes("c1",
		larkChange("m1", "oc_a", "p2p", "/fd one", false, false),
		larkChange("m2", "oc_b", "p2p", "/fd two", false, false),
	)}
	f.poll(t)
	if held := f.records(t, store.MessageDeliveryHeld); len(held) != 1 || held[0].Envelope.MessageID != "m2" {
		t.Fatalf("held: %+v", held)
	}
	if len(f.told) != 1 || f.told[0] != "held" {
		t.Fatalf("told: %v", f.told)
	}
	if released, err := f.runner.Release(context.Background(), f.channel.ID); err != nil || released != 1 {
		t.Fatalf("release: %d %v", released, err)
	}
	if queued := f.records(t, store.MessageDeliveryQueued); len(queued) != 2 {
		t.Fatalf("released: %+v", queued)
	}
}

func TestPausedChannelIsNotPolled(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.channel.Enabled = false
	if err := f.st.SaveMessageChannel(context.Background(), f.channel); err != nil {
		t.Fatal(err)
	}
	f.feed.answers = []feedAnswer{changes("c1")}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	f.runner.Run(ctx)
	if len(f.feed.queries()) != 0 {
		t.Fatal("a paused channel polled its feed")
	}
	runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID)
	if runtime.State != channels.StatePaused {
		t.Fatalf("state %q", runtime.State)
	}
}

func TestDispatchHandsOneTurnPerConversationAndFollowsIt(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.feed.answers = []feedAnswer{changes("c1",
		larkChange("m1", "oc_a", "p2p", "/fd one", false, false),
		larkChange("m2", "oc_a", "p2p", "/fd two\nsecond line", false, false),
		larkChange("m3", "oc_b", "group", "@me /fd three", true, false),
	)}
	f.poll(t)
	ctx := context.Background()
	f.runner.Dispatch(ctx)
	if len(f.inbox.all()) != 0 {
		t.Fatal("messages wait for the debounce")
	}
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	texts := f.inbox.all()
	if len(texts) != 2 {
		t.Fatalf("one turn per conversation: %d", len(texts))
	}
	var conversationA string
	for id, text := range texts {
		if f.inbox.keys[id] == "c:oc_a" {
			conversationA = id
			// The text is carried once: the trigger and what follows it.
			if strings.Contains(text, "  text: ") || !strings.Contains(text, "\n    second line\n") || !strings.Contains(text, "not the person's words") ||
				!strings.Contains(text, "  trigger: /fd\n") || !strings.Contains(text, "  text without trigger: one\n") || !strings.Contains(text, "session: new (first)") {
				t.Fatalf("notice: %s", text)
			}
			if strings.Contains(strings.ToLower(text), "you should") {
				t.Fatalf("the notice states facts only: %s", text)
			}
		}
	}
	// A new message of a conversation whose turn is running waits for it.
	f.feed.answers = []feedAnswer{changes("c2", larkChange("m4", "oc_a", "p2p", "/fd four", false, false))}
	f.poll(t)
	f.inbox.set(conversationA, channels.InboxStatus{Status: "delivered", SessionID: "sess_a"})
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	if len(f.inbox.all()) != 2 {
		t.Fatal("a running conversation gets no second turn")
	}
	delivered := 0
	for _, record := range f.records(t, store.MessageDeliveryDelivered) {
		if record.SessionID == "sess_a" && record.DeliveredAt != "" {
			delivered++
		}
	}
	if delivered != 2 {
		t.Fatalf("delivered records follow the inbox: %d", delivered)
	}
	f.inbox.set(conversationA, channels.InboxStatus{Status: "resolved", SessionID: "sess_a", ResultStatus: "completed"})
	f.runner.Dispatch(ctx)
	if len(f.inbox.all()) != 3 {
		t.Fatal("the waiting message goes once the turn ended")
	}
	if done := f.records(t, store.MessageDeliveryDone); len(done) != 2 {
		t.Fatalf("done: %d", len(done))
	}
	if sessions, _ := f.st.MessageChannelSessions(ctx, "asst_1", ""); len(sessions) != 1 || sessions[0] != "sess_a" {
		t.Fatalf("sessions: %v", sessions)
	}
	if channel, err := f.st.MessageChannelOfSession(ctx, "sess_a"); err != nil || channel.ID != f.channel.ID {
		t.Fatalf("channel of session: %v %v", channel.ID, err)
	}
}

func TestSeedInstructionsCarryTheGuideAndHowToReadTheFacts(t *testing.T) {
	channel := store.MessageChannel{ID: "mch_abc123", Name: "飞书 /fd", Guide: "只回答项目相关的问题。",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"}}
	file := channels.SeedInstructions(channel, "byte-dev OpenLark", "olk im context {message.id} --limit 50")
	for _, want := range []string{"# 消息通道「飞书 /fd」", "只回答项目相关的问题。", "olk im context {message.id} --limit 50", "hand_over", "sender is the person: yes", "只读",
		"没有哪个设置能放开写入", "Foundry Web", "`text without trigger`", "`mentions before trigger`", "`text cut`",
		"`.foundry/project-index.md`", "`.foundry/projects/`"} {
		if !strings.Contains(file, want) {
			t.Errorf("seed lacks %q:\n%s", want, file)
		}
	}
	// Without a rule, nothing says messages need a trigger.
	if strings.Contains(file, "不带触发词") {
		t.Errorf("seed claims a trigger the channel has none of:\n%s", file)
	}
	// Every rule needs a trigger: a new conversation without one never arrives,
	// but follow-ups do (on by default).
	channel.Filters.Rules = []store.MessageChannelRule{rule("dm", []string{"direct"}, "any", "any", "/ai"), rule("self", []string{"self"}, "any", "any", "/fd")}
	file = channels.SeedInstructions(channel, "byte-dev OpenLark", "")
	if !strings.Contains(file, "新会话需要触发词（「/ai」、「/fd」）；已经在续聊的话题里或引用助理消息时不用") || !strings.Contains(file, "needs_you") {
		t.Errorf("seed lacks the trigger fact:\n%s", file)
	}
	// With follow-ups off, a message without a trigger never arrives.
	channel.FollowUps = &store.MessageChannelFollowUps{Enabled: false, From: channels.FollowUpSameSender, EndCommands: []string{}}
	file = channels.SeedInstructions(channel, "", "")
	if !strings.Contains(file, "不带触发词（「/ai」、「/fd」）的消息不会转给你") {
		t.Errorf("seed lacks the follow-ups-off fact:\n%s", file)
	}
	// One rule lets any message through: no such claim.
	channel.Filters.Rules = append(channel.Filters.Rules, rule("all", []string{"direct"}, "any", "any"))
	channel.FollowUps = nil
	if file = channels.SeedInstructions(channel, "", ""); strings.Contains(file, "不带触发词") || strings.Contains(file, "新会话需要触发词") {
		t.Errorf("seed claims every message needs a trigger:\n%s", file)
	}
}

func TestCapabilitiesComeFromTheEnvelopeMapping(t *testing.T) {
	events := openLarkEvents(t)
	writes := []store.ConnectorServerHeldWrite{{Method: "POST", Path: "/agent/v1/x", CreatedMessageID: "/id",
		Footer: &store.ConnectorServerHeldWriteFooter{Text: "/text"}}}
	capabilities := channels.Capabilities(events, writes)
	if strings.Join(capabilities.ConversationKinds, ",") != "direct,group,self" || !capabilities.MentionsMe || !capabilities.FromSelf ||
		!capabilities.Threads || !capabilities.Ack || !capabilities.Footer {
		t.Fatalf("capabilities: %+v", capabilities)
	}
	empty := channels.Capabilities(store.ConnectorEventsSpec{Envelope: store.ConnectorEventsEnvelope{Fields: map[string]store.ConnectorEventsValue{"id": {Pointer: "/id"}}}}, nil)
	if len(empty.ConversationKinds) != 0 || empty.MentionsMe || empty.FromSelf || empty.Threads || empty.Ack || empty.Footer {
		t.Fatalf("a feed that marks nothing: %+v", empty)
	}
}

func TestExplainNamesTheFirstFailedCondition(t *testing.T) {
	rules := []store.MessageChannelRule{rule("dm", []string{"direct"}, "any", "no", "/fd"), rule("group", []string{"group"}, "yes", "no", "/fd")}
	message := store.MessageEnvelope{ID: "x", Conversation: store.MessageEnvelopeConversation{Kind: "group"}, Text: "/fd hi"}
	decision, checks := channels.Explain(rules, message)
	if decision.Keep || len(checks) != 2 || checks[0].Miss != channels.MissPlace || checks[1].Miss != channels.MissMention {
		t.Fatalf("%+v %+v", decision, checks)
	}
	message.MentionsMe = true
	if decision, checks := channels.Explain(rules, message); !decision.Keep || decision.Rule != "group" || checks[1].Miss != "" {
		t.Fatalf("%+v %+v", decision, checks)
	}
}

func TestSelfChatMapsToTheSelfKind(t *testing.T) {
	spec := openLarkEvents(t)
	self := larkChange("9", "oc_me", "p2p", "/ai hi", false, true)
	self["item"].(map[string]any)["author"] = map[string]any{"id": "ou_me", "name": "邓灿文"}
	self["item"].(map[string]any)["where"] = map[string]any{"id": "oc_me", "name": "邓灿文", "kind": "p2p"}
	envelope, _, err := channels.MapItem(spec.Envelope, decoded(t, self))
	if err != nil || envelope.Conversation.Kind != "self" {
		t.Fatalf("self chat: %+v %v", envelope.Conversation, err)
	}
	mine := larkChange("10", "oc_bob", "p2p", "/ai hi", false, true)
	mine["item"].(map[string]any)["author"] = map[string]any{"id": "ou_me", "name": "邓灿文"}
	if envelope, _, _ := channels.MapItem(spec.Envelope, decoded(t, mine)); envelope.Conversation.Kind != "direct" {
		t.Fatalf("my message to someone else stays direct: %+v", envelope.Conversation)
	}
	// Rules written for direct chats keep taking a self chat.
	if !channels.RuleMatches(rule("dm", []string{"direct"}, "any", "any", "/ai"), envelope) {
		t.Fatal("direct rule and self chat")
	}
}

func TestStripCommandAloneOrAfterTheTrigger(t *testing.T) {
	triggers, commands := []string{"/ai"}, []string{"/new"}
	cases := []struct {
		text, rest string
		ok         bool
	}{
		{"/new 帮我看下", "帮我看下", true},
		{"/ai /new 帮我看下", "帮我看下", true},
		{"@张三 /ai /new", "", true},
		{"/NEW", "", true},
		{"/ai 帮我 /new", "/ai 帮我 /new", false},
		{"/newx hi", "/newx hi", false},
		{"/ai，/new：帮我看下", "帮我看下", true},
		{"/ai /new 【急】看下", "【急】看下", true},
		{"/ai /new 「引用」", "「引用」", true},
	}
	for _, c := range cases {
		rest, ok := channels.StripCommand(c.text, triggers, commands)
		if ok != c.ok || strings.TrimSpace(rest) != c.rest {
			t.Errorf("%q: %q %v", c.text, rest, ok)
		}
	}
}

func TestDecideRollover(t *testing.T) {
	rule := store.MessageChannelSessionRule{IdleMinutes: 240}
	at := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	previous := store.MessageChannelDeliveryRecord{}
	previous.SessionID = "sess_old"
	state := store.MessageChannelKeyState{Segment: 2}
	idle := channels.SessionState{LastActive: at.Add(-5 * time.Hour)}
	recent := channels.SessionState{LastActive: at.Add(-time.Hour)}
	cases := []struct {
		name    string
		rule    store.MessageChannelSessionRule
		state   store.MessageChannelKeyState
		has     bool
		session channels.SessionState
		command bool
		segment int
		reason  string
	}{
		{"first message", rule, store.MessageChannelKeyState{}, false, channels.SessionState{}, false, 0, channels.NewFirst},
		{"within the idle limit", rule, state, true, recent, false, 2, ""},
		{"over the idle limit", rule, state, true, idle, false, 3, channels.NewIdle},
		{"never splits", store.MessageChannelSessionRule{IdleMinutes: 0}, state, true, idle, false, 2, ""},
		{"running", rule, state, true, channels.SessionState{Running: true, LastActive: idle.LastActive}, false, 2, ""},
		{"open work", rule, state, true, channels.SessionState{OpenWork: true, LastActive: idle.LastActive}, false, 2, ""},
		{"command", rule, state, true, recent, true, 3, channels.NewCommand},
		{"command while open work", rule, state, true, channels.SessionState{OpenWork: true, LastActive: recent.LastActive}, true, 3, channels.NewCommand},
		{"button", rule, store.MessageChannelKeyState{Segment: 2, ResetPending: channels.NewButton}, true, recent, false, 3, channels.NewButton},
		{"the last one failed", rule, state, true, channels.SessionState{Replaced: true, LastActive: recent.LastActive}, false, 2, channels.NewRestarted},
	}
	for _, c := range cases {
		got := channels.DecideRollover(c.rule, c.state, previous, c.has, c.session, true, at, c.command)
		if got.Segment != c.segment || got.Reason != c.reason || got.New != (c.reason != "") {
			t.Errorf("%s: %+v", c.name, got)
		}
		if c.reason == channels.NewIdle && (got.Previous != "sess_old" || got.Idle != 5*time.Hour) {
			t.Errorf("%s: continuity %+v", c.name, got)
		}
	}
}

func TestNoticeStatesTheFactsOfAContinuedAndANewSession(t *testing.T) {
	channel := store.MessageChannel{ID: "mch_x", Name: "工作", Filters: store.MessageChannelFilters{Rules: []store.MessageChannelRule{rule("dm", []string{"direct"}, "any", "any", "/ai")}}}
	record := store.MessageChannelDeliveryRecord{}
	record.Rule = "dm"
	record.Envelope = store.MessageEnvelope{ID: "new:1", MessageID: "1", Op: "new", OccurredAt: "2026-11-13T10:00:00Z", Text: "/ai，帮我看下",
		Conversation: store.MessageEnvelopeConversation{ID: "oc_me", Kind: "self", Name: "我"},
		Sender:       store.MessageEnvelopeSender{ID: "ou_me", Name: "我", IsSelf: true}, Attributes: map[string]string{"replyToMe": "true"}}
	last := time.Date(2026, 11, 13, 4, 0, 0, 0, time.UTC)
	notice := channels.Notice(channel, "OpenLark", "olk im context {message.id} --limit 50", "olk im reply {message.id} --thread",
		channels.Rollover{New: true, Reason: channels.NewIdle, Idle: 6 * time.Hour, Previous: "sess_old", PreviousLast: last}, []store.MessageChannelDeliveryRecord{record})
	for _, want := range []string{
		"channel: mch_x \"工作\"\n", "source: OpenLark\n", "conversation: self oc_me \"我\" (your own chat)\n", "session: new (idle 6h0m0s)\n",
		"earlier session: sess_old (last active 2026-11-13T04:00:00Z)\n", "context: olk im context 1 --limit 50\n",
		"reply: olk im reply 1 --thread\n",
		"  sender: \"我\" (ou_me), the person\n", "  sender is the person: yes\n", "  attribute replyToMe: true\n", "  rule: dm\n", "  trigger: /ai\n", "  text without trigger: 帮我看下\n",
	} {
		if !strings.Contains(notice, want) {
			t.Errorf("notice lacks %q:\n%s", want, notice)
		}
	}
	if !strings.HasPrefix(notice, "[Message channel: messages from the person]\n") || strings.Contains(notice, "  text: ") {
		t.Errorf("the person's batch reads as theirs, its text once:\n%s", notice)
	}
	// Long text: carried once, cut marker kept.
	long := record
	long.Envelope.Text, long.Envelope.TextTruncated = "@bot /ai "+strings.Repeat("长", 3000), true
	cut := channels.Notice(channel, "", "", "", channels.Rollover{}, []store.MessageChannelDeliveryRecord{long})
	if strings.Count(cut, "长长长长") == 0 || strings.Count(cut, strings.Repeat("长", 3000)) != 1 || !strings.Contains(cut, "  mentions before trigger: @bot\n") || !strings.Contains(cut, "  text cut: yes, at 8 KB\n") {
		t.Errorf("long text:\n%.400s", cut)
	}
	other := record
	other.Rule, other.Envelope.Text = "", "随便说一句"
	other.Envelope.Sender = store.MessageEnvelopeSender{ID: "ou_x", Name: "X"}
	if text := channels.Notice(channel, "", "", "", channels.Rollover{}, []store.MessageChannelDeliveryRecord{other}); !strings.HasPrefix(text, "[Message channel: messages from other people, not the person's words]\n") || !strings.Contains(text, "  text: 随便说一句\n") {
		t.Errorf("others' batch:\n%s", text)
	}
	if text := channels.Notice(channel, "", "", "", channels.Rollover{}, []store.MessageChannelDeliveryRecord{record, other}); !strings.HasPrefix(text, "[Message channel: messages from the person and from other people;") {
		t.Errorf("mixed batch:\n%s", text)
	}
	continued := channels.Notice(channel, "OpenLark", "", "", channels.Rollover{}, []store.MessageChannelDeliveryRecord{record})
	if !strings.Contains(continued, "session: continued\n") || strings.Contains(continued, "earlier session") || strings.Contains(continued, "context:") {
		t.Fatalf("continued: %s", continued)
	}
}

// Two messages of one conversation five hours apart go to two linked
// sessions; a message within the limit goes on in the same one.
func TestDispatchStartsANewSessionAfterTheIdleLimit(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	turn := func(id string) (string, string) {
		f.feed.answers = []feedAnswer{changes("c-"+id, larkChange(id, "oc_a", "p2p", "/fd "+id, false, false))}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(ctx)
		for entry, text := range f.inbox.all() {
			if _, seen := before[entry]; !seen {
				f.inbox.set(entry, channels.InboxStatus{Status: "resolved", SessionID: "sess_" + f.inbox.inboxes[entry], ResultStatus: "completed"})
				f.runner.Dispatch(ctx)
				f.sessions["sess_"+f.inbox.inboxes[entry]] = channels.SessionState{LastActive: f.now}
				return f.inbox.inboxes[entry], text
			}
		}
		t.Fatalf("no turn for %s", id)
		return "", ""
	}
	first, _ := turn("m1")
	f.now = f.now.Add(time.Hour)
	same, text := turn("m2")
	if same != first || !strings.Contains(text, "session: continued") {
		t.Fatalf("within the limit: %s %s\n%s", first, same, text)
	}
	f.now = f.now.Add(5 * time.Hour)
	next, text := turn("m3")
	if next != first+":1" || !strings.Contains(text, "session: new (idle") || !strings.Contains(text, "earlier session: sess_"+first) {
		t.Fatalf("after the limit: %s %s\n%s", first, next, text)
	}
	records := f.records(t, store.MessageDeliveryDone)
	news := 0
	for _, record := range records {
		if record.SessionNew {
			news++
		}
	}
	if news != 2 {
		t.Fatalf("two sessions began: %d", news)
	}
	// The person's button: the next message starts fresh.
	if err := f.runner.RequestNewSession(ctx, f.channel.ID, "c:oc_a"); err != nil {
		t.Fatal(err)
	}
	after, text := turn("m4")
	if after != first+":2" || !strings.Contains(text, "session: new (button)") {
		t.Fatalf("button: %s\n%s", after, text)
	}
}

// Once a message matched, a later message of the same thread continues it
// without a trigger word; another sender, a plain note in a self chat and a
// message outside the thread do not.
func TestFollowUpsContinueAThreadWithoutATrigger(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	f.channel.Filters.Rules = append(f.channel.Filters.Rules, rule("self", []string{"self"}, "any", "any", "/fd"))
	// The default follow-up is thread-participants; this test pins same-sender.
	f.channel.FollowUps = &store.MessageChannelFollowUps{Enabled: true, From: channels.FollowUpSameSender, EndCommands: []string{"/end"}}
	if err := f.st.SaveMessageChannel(ctx, f.channel); err != nil {
		t.Fatal(err)
	}
	post := func(cursor string, change map[string]any) map[string]string {
		f.feed.answers = []feedAnswer{changes(cursor, change)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(ctx)
		out := map[string]string{}
		for id, text := range f.inbox.all() {
			if _, seen := before[id]; !seen {
				out[id] = text
			}
		}
		return out
	}
	resolve := func(entries map[string]string) {
		for id := range entries {
			f.inbox.set(id, channels.InboxStatus{Status: "resolved", SessionID: "sess_" + f.inbox.inboxes[id], ResultStatus: "completed"})
			f.runner.Dispatch(ctx)
			f.sessions["sess_"+f.inbox.inboxes[id]] = channels.SessionState{LastActive: f.now}
		}
	}

	trigger := post("c1", larkChange("m1", "oc_a", "p2p", "/fd 开始", false, false))
	if len(trigger) != 1 {
		t.Fatalf("trigger: %v", trigger)
	}
	var firstInbox string
	for id, text := range trigger {
		firstInbox = f.inbox.inboxes[id]
		if !strings.Contains(text, "reply: olk im reply m1\n") {
			t.Fatalf("the trigger's notice states the reply command:\n%s", text)
		}
	}
	resolve(trigger)

	followUp := post("c2", larkChange("m2", "oc_a", "p2p", "接着说", false, false))
	if len(followUp) != 1 {
		t.Fatalf("a follow-up arrives without a trigger: %v", followUp)
	}
	for id, text := range followUp {
		if f.inbox.inboxes[id] != firstInbox {
			t.Fatalf("the follow-up continues the session: %s != %s", f.inbox.inboxes[id], firstInbox)
		}
		for _, want := range []string{"  rule: follow_up\n", "  follow-up: thread th_1 (since ", "reply: olk im reply m2\n", "session: continued\n"} {
			if !strings.Contains(text, want) {
				t.Errorf("follow-up notice lacks %q:\n%s", want, text)
			}
		}
	}
	resolve(followUp)
	all := f.records(t)
	followed := 0
	for _, record := range all {
		if record.Envelope.MessageID == "m2" {
			followed++
			if record.Rule != channels.RuleFollowUp || !strings.Contains(record.FollowUp, "thread th_1 (since ") {
				t.Fatalf("follow-up record: %+v", record)
			}
		}
	}
	if followed != 1 {
		t.Fatalf("follow-up records: %d", followed)
	}

	// Another person in the thread does not continue it.
	other := larkChange("m3", "oc_a", "p2p", "我也说一句", false, false)
	other["item"].(map[string]any)["author"] = map[string]any{"id": "ou_other", "name": "李四"}
	if got := post("c3", other); len(got) != 0 {
		t.Fatalf("another sender continued the thread: %v", got)
	}

	// A quote of a delivered message continues a chat without threads.
	if got := post("c4", larkChange("m4", "oc_b", "p2p", "/fd 另一件事", false, false)); len(got) != 1 {
		t.Fatalf("second trigger: %v", got)
	} else {
		resolve(got)
	}
	quote := larkChange("m5", "oc_b", "p2p", "引用回复", false, false)
	delete(quote["item"].(map[string]any), "thread")
	quote["item"].(map[string]any)["refs"] = []any{map[string]any{"rel": "parent", "id": "msg:m4"}}
	if got := post("c5", quote); len(got) != 1 {
		t.Fatalf("a quote did not continue: %v", got)
	} else {
		for _, text := range got {
			if !strings.Contains(text, "  rule: follow_up\n") || !strings.Contains(text, "  follow-up: quote m4 (since ") {
				t.Errorf("quote notice:\n%s", text)
			}
		}
		resolve(got)
	}

	// A self-chat note without a trigger stays out; the trigger started it.
	selfChange := func(id, text string) map[string]any {
		change := larkChange(id, "oc_me", "p2p", text, false, true)
		change["item"].(map[string]any)["author"] = map[string]any{"id": "ou_me", "name": "邓灿文"}
		change["item"].(map[string]any)["where"] = map[string]any{"id": "oc_me", "name": "邓灿文", "kind": "p2p"}
		return change
	}
	if got := post("c6", selfChange("m6", "/fd 自聊开始")); len(got) != 1 {
		t.Fatalf("self trigger: %v", got)
	} else {
		resolve(got)
	}
	note := selfChange("m7", "记一下")
	delete(note["item"].(map[string]any), "thread")
	if got := post("c7", note); len(got) != 0 {
		t.Fatalf("a note-to-self without a trigger came through: %v", got)
	}
}

// A follow-up after the idle limit still matches, but starts the next
// segment; an end command stops the conversation's follow-ups.
func TestFollowUpAfterIdleAndEndCommand(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	post := func(cursor string, change map[string]any) map[string]string {
		f.feed.answers = []feedAnswer{changes(cursor, change)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(ctx)
		out := map[string]string{}
		for id, text := range f.inbox.all() {
			if _, seen := before[id]; !seen {
				out[id] = text
			}
		}
		return out
	}
	resolve := func(entries map[string]string) {
		for id := range entries {
			f.inbox.set(id, channels.InboxStatus{Status: "resolved", SessionID: "sess_" + f.inbox.inboxes[id], ResultStatus: "completed"})
			f.runner.Dispatch(ctx)
			f.sessions["sess_"+f.inbox.inboxes[id]] = channels.SessionState{LastActive: f.now}
		}
	}
	first := post("c1", larkChange("m1", "oc_a", "p2p", "/fd 开始", false, false))
	resolve(first)
	var before string
	for id := range first {
		before = f.inbox.inboxes[id]
	}
	f.now = f.now.Add(5 * time.Hour)
	after := post("c2", larkChange("m2", "oc_a", "p2p", "过了很久接着说", false, false))
	if len(after) != 1 {
		t.Fatalf("an idle follow-up still arrives: %v", after)
	}
	newest := ""
	for id, text := range after {
		newest = f.inbox.inboxes[id]
		if newest == before || !strings.Contains(newest, ":1") {
			t.Fatalf("the idle follow-up starts the next segment: %s", newest)
		}
		if !strings.Contains(text, "session: new (idle") || !strings.Contains(text, "  rule: follow_up\n") {
			t.Fatalf("idle follow-up notice:\n%s", text)
		}
	}
	resolve(after)

	// /end ends it: nothing is posted, and a plain follow-up no longer arrives.
	if got := post("c3", larkChange("m3", "oc_a", "p2p", "/end", false, false)); len(got) != 0 {
		t.Fatalf("the end command was handed over: %v", got)
	}
	ended := f.records(t, store.MessageDeliveryDropped)
	found := false
	for _, record := range ended {
		if record.Envelope.MessageID == "m3" {
			found = record.Reason == channels.ReasonFollowUpEnd
		}
	}
	if !found {
		t.Fatalf("the end command was not recorded: %+v", ended)
	}
	key, _ := f.st.GetMessageChannelKey(ctx, f.channel.ID, "c:oc_a")
	if key.ResetPending != channels.NewFollowUpEnd {
		t.Fatalf("ended follow-ups leave the next trigger a new session: %+v", key)
	}
	if got := post("c4", larkChange("m4", "oc_a", "p2p", "还在吗", false, false)); len(got) != 0 {
		t.Fatalf("a follow-up came through after /end: %v", got)
	}
}

// Two messages delivered as one batch and answered separately: the
// assistant's reply quotes an older message of the pair, but the id its
// gateway write recorded drops it. A person quoting that reply still
// continues the conversation.
func TestOwnWriteOfABatchIsDroppedAndAPersonsReplyStillFollows(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	post := func(cursor string, items ...map[string]any) map[string]string {
		f.feed.answers = []feedAnswer{changes(cursor, items...)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(ctx)
		out := map[string]string{}
		for id, text := range f.inbox.all() {
			if _, seen := before[id]; !seen {
				out[id] = text
			}
		}
		return out
	}
	resolve := func(entries map[string]string) {
		for id := range entries {
			f.inbox.set(id, channels.InboxStatus{Status: "resolved", SessionID: "sess_" + f.inbox.inboxes[id], ResultStatus: "completed"})
			f.runner.Dispatch(ctx)
			f.sessions["sess_"+f.inbox.inboxes[id]] = channels.SessionState{LastActive: f.now}
		}
	}

	trigger := post("c1", larkChange("m1", "oc_a", "p2p", "/fd 开始", false, false))
	if len(trigger) != 1 {
		t.Fatalf("trigger: %v", trigger)
	}
	resolve(trigger)
	// The pair arrives together and is delivered as one turn.
	if batch := post("c2", larkChange("m2", "oc_a", "p2p", "第一件", false, false),
		larkChange("m3", "oc_a", "p2p", "第二件", false, false)); len(batch) != 1 {
		t.Fatalf("the pair is one turn: %v", batch)
	} else {
		resolve(batch)
	}
	// The assistant answers the older message of the pair. The source marks
	// no write, but the gateway recorded m9 as created by its write.
	f.ownWrites["m9"] = true
	reply := larkChange("m9", "oc_a", "p2p", "回第一件", false, true)
	reply["item"].(map[string]any)["author"] = map[string]any{"id": "ou_me", "name": "本人"}
	reply["item"].(map[string]any)["refs"] = []any{map[string]any{"rel": "parent", "id": "msg:m2"}}
	if got := post("c3", reply); len(got) != 0 {
		t.Fatalf("the assistant answered itself: %v", got)
	}
	dropped := f.records(t, store.MessageDeliveryDropped)
	found := false
	for _, record := range dropped {
		if record.Envelope.MessageID == "m9" {
			found = record.Reason == channels.ReasonOwnWrite && record.Envelope.Text == ""
		}
	}
	if !found {
		t.Fatalf("the own write is recorded as own_write: %+v", dropped)
	}

	// A person quoting the assistant's reply continues the conversation.
	other := post("c4", larkChange("m4", "oc_b", "p2p", "/fd 另一件事", false, false))
	if len(other) != 1 {
		t.Fatalf("second trigger: %v", other)
	}
	resolve(other)
	f.ownWrites["m5"] = true
	person := larkChange("m6", "oc_b", "p2p", "接着说", false, false)
	delete(person["item"].(map[string]any), "thread")
	person["item"].(map[string]any)["signals"] = map[string]any{"replyToMe": true}
	person["item"].(map[string]any)["refs"] = []any{map[string]any{"rel": "parent", "id": "msg:m5"}}
	if got := post("c5", person); len(got) != 1 {
		t.Fatalf("a person quoting the assistant's reply did not continue: %v", got)
	} else {
		for _, text := range got {
			if !strings.Contains(text, "  rule: follow_up\n") || !strings.Contains(text, "  follow-up: quote (since ") {
				t.Errorf("person quote notice:\n%s", text)
			}
		}
	}
}

// Without the own-write check nothing is delivered: the cursor stays and the
// same batch is read again when the check works.
func TestOwnWriteCheckFailureHoldsTheBatch(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	change := larkChange("m1", "oc_a", "p2p", "/fd 开始", false, false)
	f.feed.answers = []feedAnswer{changes("c1", change)}
	f.ownWritesErr = errors.New("the audit store is unavailable")
	f.poll(t)
	if all := f.records(t); len(all) != 0 {
		t.Fatalf("a batch was recorded without the own-write check: %+v", all)
	}
	runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID)
	if runtime.Cursor != "" || runtime.State != channels.StateBackingOff {
		t.Fatalf("the cursor stayed and the channel backs off: %+v", runtime)
	}
	// The source answers the same batch for the unchanged cursor.
	f.feed.answers = []feedAnswer{changes("c1", change)}
	f.ownWritesErr = nil
	f.poll(t)
	queued := f.records(t, store.MessageDeliveryQueued)
	if len(queued) != 1 || queued[0].Envelope.MessageID != "m1" {
		t.Fatalf("the batch is delivered once the check works: %+v", queued)
	}
	if runtime, _ := f.st.GetMessageChannelRuntime(context.Background(), f.channel.ID); runtime.Cursor != "c1" {
		t.Fatalf("the cursor moved: %+v", runtime)
	}
}

// The acknowledgement reaction follows the hand-over: it goes on every
// message of a handed batch (not on dropped ones), and comes off when the
// turn ends, however it ended.
func joinedAckIDs(ids []string) string {
	sorted := append([]string(nil), ids...)
	slices.Sort(sorted)
	return strings.Join(sorted, ",")
}

func TestAckFollowsTheHandOverAndTheTurn(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.feed.answers = []feedAnswer{changes("c1",
		larkChange("m1", "oc_a", "p2p", "/fd one", false, false),
		larkChange("m2", "oc_a", "p2p", "/fd two", false, false),
		larkChange("m9", "oc_b", "p2p", "hello", false, false),
	)}
	f.poll(t)
	ctx := context.Background()
	f.runner.Dispatch(ctx)
	if len(f.acks) != 0 {
		t.Fatalf("no reaction before the turn is handed over: %+v", f.acks)
	}
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	if len(f.acks) != 1 || !f.acks[0].add || joinedAckIDs(f.acks[0].ids) != "m1,m2" {
		t.Fatalf("a reaction on the handed batch: %+v", f.acks)
	}
	var conversationA string
	for id := range f.inbox.all() {
		if f.inbox.keys[id] == "c:oc_a" {
			conversationA = id
		}
	}
	if conversationA == "" {
		t.Fatal("no turn for oc_a")
	}
	f.inbox.set(conversationA, channels.InboxStatus{Status: "delivered", SessionID: "sess_a"})
	f.runner.Dispatch(ctx)
	f.inbox.set(conversationA, channels.InboxStatus{Status: "resolved", SessionID: "sess_a", ResultStatus: "completed"})
	f.runner.Dispatch(ctx)
	if last := f.acks[len(f.acks)-1]; last.add || joinedAckIDs(last.ids) != "m1,m2" {
		t.Fatalf("a completed turn takes the reaction off: %+v", f.acks)
	}

	// A failed turn takes it off too.
	f.feed.answers = []feedAnswer{changes("c2", larkChange("m3", "oc_a", "p2p", "/fd three", false, false))}
	f.poll(t)
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	if last := f.acks[len(f.acks)-1]; !last.add || joinedAckIDs(last.ids) != "m3" {
		t.Fatalf("a reaction on the next batch: %+v", f.acks)
	}
	var nextInbox string
	for id := range f.inbox.all() {
		if f.inbox.keys[id] == "c:oc_a" && id != conversationA {
			nextInbox = id
		}
	}
	if nextInbox == "" {
		t.Fatal("no turn for the next batch of oc_a")
	}
	f.inbox.set(nextInbox, channels.InboxStatus{Status: "delivered", SessionID: "sess_b"})
	f.runner.Dispatch(ctx)
	f.inbox.set(nextInbox, channels.InboxStatus{Status: "resolved", SessionID: "sess_b", ResultStatus: "failed"})
	f.runner.Dispatch(ctx)
	if last := f.acks[len(f.acks)-1]; last.add || joinedAckIDs(last.ids) != "m3" {
		t.Fatalf("a failed turn takes the reaction off: %+v", f.acks)
	}
}

func TestAnAckFailureDoesNotBlockTheHandOver(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.ackErr = errors.New("the connector would not take the reaction")
	f.feed.answers = []feedAnswer{changes("c1", larkChange("m1", "oc_a", "p2p", "/fd one", false, false))}
	f.poll(t)
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(context.Background())
	if len(f.inbox.all()) != 1 {
		t.Fatal("the turn is handed over even when the reaction fails")
	}
}

// A source's reaction change is not a message, even when its text would
// match a rule or continue a thread.
func TestAReactionChangeIsNotAMessage(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	reaction := larkChange("m1", "oc_a", "p2p", "/fd hi", false, false)
	reaction["kind"], reaction["op"] = "reaction", "update"
	reaction["item"].(map[string]any)["kind"] = "reaction"
	f.feed.answers = []feedAnswer{changes("c1", reaction)}
	f.poll(t)
	if all := f.records(t); len(all) != 0 {
		t.Fatalf("a reaction change makes no delivery record: %+v", all)
	}
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(context.Background())
	if len(f.inbox.all()) != 0 || len(f.acks) != 0 {
		t.Fatalf("a reaction change starts no turn: %d %+v", len(f.inbox.all()), f.acks)
	}
}

// A channel's folder is its name as a path segment under the assistant
// home's channels/ (DEV-251).
func TestChannelFolderSlug(t *testing.T) {
	for name, want := range map[string]string{
		"Lark /fd":      "lark-fd",
		" ByteWork 通道 ": "bytework-通道",
		"财经 日报":         "财经-日报",
	} {
		channel := store.MessageChannel{ID: "mch_0e47207b", Name: name}
		if got := channels.FolderSlug(channel); got != want {
			t.Errorf("FolderSlug(%q) = %q, want %q", name, got, want)
		}
	}
	if got := channels.FolderSlug(store.MessageChannel{ID: "mch_0e47207b6ad14d91", Name: "!!!"}); got != "channel-0e47207b" {
		t.Errorf("a name with nothing usable: %q", got)
	}
}

// A thread reply from another participant continues the thread's turn when
// the channel says thread-participants, and is not a trigger either way
// (DEV-268).
func TestThreadParticipantRepliesFollowUpBySetting(t *testing.T) {
	post := func(f *fixture, cursor string, change map[string]any) map[string]string {
		f.feed.answers = []feedAnswer{changes(cursor, change)}
		f.poll(t)
		f.now = f.now.Add(channels.Debounce + time.Second)
		before := f.inbox.all()
		f.runner.Dispatch(context.Background())
		out := map[string]string{}
		for id, text := range f.inbox.all() {
			if _, seen := before[id]; !seen {
				out[id] = text
			}
		}
		return out
	}
	resolve := func(f *fixture, entries map[string]string) {
		for id := range entries {
			f.inbox.set(id, channels.InboxStatus{Status: "resolved", SessionID: "sess_" + f.inbox.inboxes[id], ResultStatus: "completed"})
			f.runner.Dispatch(context.Background())
			f.sessions["sess_"+f.inbox.inboxes[id]] = channels.SessionState{LastActive: f.now}
		}
	}
	other := func(id string) map[string]any {
		change := larkChange(id, "oc_a", "p2p", "不对吧，这个都不是 autofix 处理的", false, false)
		change["item"].(map[string]any)["author"] = map[string]any{"id": "ou_other", "name": "区浩辉"}
		return change
	}

	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.channel.FollowUps = &store.MessageChannelFollowUps{Enabled: true, From: channels.FollowUpThreadParticipants, EndCommands: []string{"/end"}}
	if err := f.st.SaveMessageChannel(context.Background(), f.channel); err != nil {
		t.Fatal(err)
	}
	trigger := post(f, "c1", larkChange("m1", "oc_a", "p2p", "/fd 查一下", false, false))
	if len(trigger) != 1 {
		t.Fatalf("trigger: %v", trigger)
	}
	resolve(f, trigger)
	following := post(f, "c2", other("m2"))
	if len(following) != 1 {
		t.Fatalf("a thread participant's reply continues the thread: %v", following)
	}
	for _, text := range following {
		if !strings.Contains(text, "  rule: follow_up\n") ||
			!strings.Contains(text, `follow-up: thread th_1 (since `) ||
			!strings.Contains(text, `by "区浩辉" (ou_other), not the person`) ||
			!strings.Contains(text, "  sender: \"区浩辉\" (ou_other), not the person\n") {
			t.Fatalf("follow-up notice lacks who wrote it:\n%s", text)
		}
	}
	// /end ends it, whoever sends it in the thread.
	if ended := post(f, "c3", func() map[string]any {
		change := larkChange("m3", "oc_a", "p2p", "/end", false, false)
		change["item"].(map[string]any)["author"] = map[string]any{"id": "ou_other", "name": "区浩辉"}
		return change
	}()); len(ended) != 0 {
		t.Fatalf("the end command was handed over: %v", ended)
	}
	if after := post(f, "c4", other("m4")); len(after) != 0 {
		t.Fatalf("a follow-up came through after /end: %v", after)
	}

	// same-sender keeps the old rule: another participant does not continue.
	same := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	same.channel.FollowUps = &store.MessageChannelFollowUps{Enabled: true, From: channels.FollowUpSameSender, EndCommands: []string{"/end"}}
	if err := same.st.SaveMessageChannel(context.Background(), same.channel); err != nil {
		t.Fatal(err)
	}
	first := post(same, "s1", larkChange("m1", "oc_a", "p2p", "/fd 查一下", false, false))
	resolve(same, first)
	if got := post(same, "s2", other("m2")); len(got) != 0 {
		t.Fatalf("same-sender dropped another participant's reply: %v", got)
	}
	dropped := same.records(t, store.MessageDeliveryDropped)
	found := false
	for _, record := range dropped {
		if record.Envelope.MessageID == "m2" {
			found = record.Reason == "no_rule_matched" && record.Envelope.Text == ""
		}
	}
	if !found {
		t.Fatalf("the other participant's reply was not recorded as dropped: %+v", dropped)
	}
}

// The acknowledgement reaction stays on the trigger while the turn's helper
// runs, and comes off once the turn and its helpers have ended (DEV-268).
func TestAckStaysWhileAHelperRuns(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	f.feed.answers = []feedAnswer{changes("c1", larkChange("m1", "oc_a", "p2p", "/fd 查一下", false, false))}
	f.poll(t)
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	entries := f.inbox.all()
	if len(entries) != 1 {
		t.Fatalf("turn: %v", entries)
	}
	var inboxID string
	for id := range entries {
		inboxID = id
	}
	if len(f.acks) != 1 || !f.acks[0].add || len(f.acks[0].ids) != 1 || f.acks[0].ids[0] != "m1" {
		t.Fatalf("the reaction went on the trigger: %+v", f.acks)
	}
	held := f.records(t)
	if len(held) != 1 || !held[0].AckHeld {
		t.Fatalf("the delivery remembers its held reaction: %+v", held)
	}
	// The turn ends while its helper still runs: the reaction stays.
	f.inbox.set(inboxID, channels.InboxStatus{Status: "resolved", SessionID: "sess_a", ResultStatus: "completed"})
	f.working["sess_a"] = true
	f.runner.Dispatch(ctx)
	if len(f.acks) != 1 {
		t.Fatalf("the reaction came off while a helper ran: %+v", f.acks)
	}
	// The helper ends: the reaction comes off.
	f.working["sess_a"] = false
	f.runner.Dispatch(ctx)
	if len(f.acks) != 2 || f.acks[1].add || len(f.acks[1].ids) != 1 || f.acks[1].ids[0] != "m1" {
		t.Fatalf("the reaction stayed after the helpers ended: %+v", f.acks)
	}
	done := f.records(t, store.MessageDeliveryDone)
	if len(done) != 1 || done[0].AckHeld {
		t.Fatalf("the delivery no longer holds a reaction: %+v", done)
	}
	f.runner.Dispatch(ctx)
	if len(f.acks) != 2 {
		t.Fatalf("an already settled reaction was removed twice: %+v", f.acks)
	}
}

// A thread turn is named as a direct chat with the other participant and
// carries its root and earlier replies, read through the source's declared
// reads (DEV-268).
func TestHandOverNamesAThreadAndReadsItsRoot(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	f.channel.Filters.Rules = append(f.channel.Filters.Rules, rule("self", []string{"direct"}, "any", "yes", "/fd"))
	if err := f.st.SaveMessageChannel(context.Background(), f.channel); err != nil {
		t.Fatal(err)
	}
	f.feed.reads["/agent/v1/conversations/oc_a"] = feedAnswer{status: 200, body: map[string]any{"name": "区浩辉", "chatMode": "direct"}}
	f.feed.reads["/agent/v1/messages/th_1"] = feedAnswer{status: 200, body: map[string]any{"item": map[string]any{
		"id": "th_1", "senderName": "区浩辉", "senderId": "ou_other", "isMine": false,
		"createdAt": "2026-11-12T16:00:47Z", "textPreview": "",
		"parts": []any{map[string]any{"kind": "card", "metadata": map[string]any{
			"summaryElements": []any{map[string]any{"kind": "text", "content": "[缺陷] Word 标尺重复查询完整布局"}},
		}}},
	}}}
	f.feed.reads["/agent/v1/messages/th_1/thread"] = feedAnswer{status: 200, body: map[string]any{"items": []any{
		map[string]any{"id": "th_1", "senderName": "区浩辉", "senderId": "ou_other", "createdAt": "2026-11-12T16:00:47Z", "parts": []any{}},
		map[string]any{"id": "m0", "senderName": "区浩辉", "senderId": "ou_other", "createdAt": "2026-11-12T16:00:50Z", "textPreview": "截图在附件"},
		map[string]any{"id": "m1", "senderName": "邓灿文", "senderId": "ou_me", "isMine": true, "createdAt": "2026-11-12T16:13:20Z", "textPreview": "/fd 查一下"},
		map[string]any{"id": "m9", "senderName": "区浩辉", "senderId": "ou_other", "createdAt": "2026-11-12T16:20:35Z", "textPreview": "后来的话"},
	}}}
	change := larkChange("m1", "oc_a", "p2p", "/fd 查一下这个tag", false, true)
	change["item"].(map[string]any)["author"] = map[string]any{"id": "ou_me", "name": "邓灿文"}
	change["item"].(map[string]any)["refs"] = []any{map[string]any{"rel": "parent", "id": "msg:th_1"}}
	f.feed.answers = []feedAnswer{changes("c1", change)}
	f.poll(t)
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(context.Background())
	texts := f.inbox.all()
	if len(texts) != 1 {
		t.Fatalf("turn: %v", texts)
	}
	for _, text := range texts {
		for _, want := range []string{
			"conversation: direct oc_a \"区浩辉\" (direct chat with 区浩辉)\n",
			"thread: th_1 (reply); thread under \"区浩辉\" (ou_other), not the person at 2026-11-12T16:00:47Z\n",
			"\nthread root:\n",
			"  text: [缺陷] Word 标尺重复查询完整布局\n",
			"\nthread earlier replies: 1\n",
			"2026-11-12T16:00:50Z \"区浩辉\" (ou_other), not the person: 截图在附件\n",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("thread notice lacks %q:\n%s", want, text)
			}
		}
		if strings.Contains(text, "后来的话") {
			t.Fatalf("a reply after the trigger is not handed over:\n%s", text)
		}
	}
	// The resolved name is stored, so the session title and the channel view
	// name the conversation too.
	stored := f.records(t)
	if len(stored) != 1 || stored[0].Envelope.Conversation.Name != "区浩辉" {
		t.Fatalf("stored conversation name: %+v", stored)
	}
}

// Someone else writing in the conversation while the request is open is
// handed to the running turn as context, never as a trigger; the cap holds
// and says so (DEV-268).
func TestOtherParticipantsMessageWhileOpenIsContext(t *testing.T) {
	f := newFixture(t, store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3})
	ctx := context.Background()
	f.inbox.mu.Lock()
	f.inbox.entries["inbox_placeholder"] = channels.InboxStatus{}
	f.inbox.mu.Unlock()
	trigger := larkChange("m1", "oc_a", "p2p", "/fd 查一下", false, false)
	delete(trigger["item"].(map[string]any), "thread")
	f.feed.answers = []feedAnswer{changes("c1", trigger)}
	f.poll(t)
	f.now = f.now.Add(channels.Debounce + time.Second)
	f.runner.Dispatch(ctx)
	var inboxID string
	for id := range f.inbox.all() {
		inboxID = id
	}
	f.inbox.set(inboxID, channels.InboxStatus{Status: "delivered", SessionID: "sess_a"})
	f.working["sess_a"] = true
	f.runner.Dispatch(ctx)

	other := func(id, text string) map[string]any {
		change := larkChange(id, "oc_a", "p2p", text, false, false)
		change["item"].(map[string]any)["author"] = map[string]any{"id": "ou_other", "name": "区浩辉"}
		delete(change["item"].(map[string]any), "thread")
		return change
	}
	f.feed.answers = []feedAnswer{changes("c2", other("c1", "这个单是我之前人工的"))}
	f.poll(t)
	f.runner.Dispatch(ctx)
	if len(f.contextTexts()) != 1 {
		t.Fatalf("context updates: %+v", f.contextTexts())
	}
	f.mu.Lock()
	if f.contexts[0].sessionID != "sess_a" {
		t.Fatalf("the context went to the open turn: %+v", f.contexts[0])
	}
	f.mu.Unlock()
	if text := f.contexts[0].turn.Text; !strings.Contains(text, "[Message channel context:") ||
		!strings.Contains(text, `sender: "区浩辉" (ou_other), not the person`) ||
		!strings.Contains(text, "not a new request") ||
		!strings.Contains(text, "这个单是我之前人工的") {
		t.Fatalf("context notice:\n%s", text)
	}
	if inbox := f.inbox.all(); len(inbox) != 1 {
		t.Fatalf("a context message started an inbox turn: %v", inbox)
	}
	f.records(t, store.MessageDeliveryContext)

	// The cap: 21 more messages from the same participant; 20 go, one is
	// dropped as over the cap.
	items := make([]map[string]any, 0, 21)
	for i := 0; i < 21; i++ {
		items = append(items, other(fmt.Sprintf("cap%d", i), "补充一句"))
	}
	f.feed.answers = []feedAnswer{changes("c3", items...)}
	f.poll(t)
	f.runner.Dispatch(ctx)
	if len(f.contextTexts()) < 2 {
		var statuses []string
		for _, record := range f.records(t) {
			statuses = append(statuses, string(record.Status)+":"+record.Reason+":"+record.Envelope.MessageID+":"+record.SessionID)
		}
		t.Fatalf("the cap batch was not delivered: %+v; records %v", f.contextTexts(), statuses)
	}
	capped := false
	for _, text := range f.contextTexts() {
		if strings.Contains(text, "the cap of 20 messages or 8 KB is reached") {
			capped = true
		}
	}
	if !capped {
		t.Fatalf("the context notice does not say the cap was reached: %+v", f.contextTexts())
	}
	dropped := 0
	for _, record := range f.records(t, store.MessageDeliveryDropped) {
		if record.Reason == channels.ReasonContextCapped {
			dropped++
		}
	}
	if dropped == 0 {
		t.Fatal("no message was dropped over the context cap")
	}
}
