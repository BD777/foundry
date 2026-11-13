package channels_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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

// feed is a fake event feed: what each poll answers, and what it was asked.
type feed struct {
	mu      sync.Mutex
	answers []feedAnswer
	asked   []url.Values
}

type feedAnswer struct {
	status int
	body   any
}

func (f *feed) Get(ctx context.Context, path string, query url.Values) (int, []byte, http.Header, error) {
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

type fixture struct {
	st       *sqlitestore.Store
	feed     *feed
	inbox    *inbox
	runner   *channels.Runner
	now      time.Time
	told     []string
	channel  store.MessageChannelRecord
	sessions map[string]channels.SessionState
}

func newFixture(t *testing.T, limits store.MessageChannelLimits) *fixture {
	t.Helper()
	st, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, feed: &feed{}, inbox: newInbox(), now: time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC), sessions: map[string]channels.SessionState{}}
	spec := openLarkEvents(t)
	f.runner = channels.NewRunner(channels.Ports{
		Store: st,
		Open: func(ctx context.Context, channel store.MessageChannelRecord) (channels.Source, error) {
			return channels.LongPoll{Spec: spec, Upstream: f.feed}, nil
		},
		Inbox: f.inbox,
		Tell: func(ctx context.Context, channel store.MessageChannelRecord, key, title, detail string) {
			f.told = append(f.told, key)
		},
		Now: func() time.Time { return f.now },
		Session: func(ctx context.Context, id string) (channels.SessionState, bool) {
			state, ok := f.sessions[id]
			return state, ok
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
			if !strings.Contains(text, "  text: /fd one\n") || !strings.Contains(text, "\n    second line\n") || !strings.Contains(text, "not the person's words") ||
				!strings.Contains(text, "  text without trigger: one\n") || !strings.Contains(text, "session: new (first)") {
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
	for _, want := range []string{"# 消息通道「飞书 /fd」", "只回答项目相关的问题。", "olk im context {message.id} --limit 50", "hand_over", "sender is the person: yes", "只读"} {
		if !strings.Contains(file, want) {
			t.Errorf("seed lacks %q:\n%s", want, file)
		}
	}
}

func TestCapabilitiesComeFromTheEnvelopeMapping(t *testing.T) {
	capabilities := channels.Capabilities(openLarkEvents(t).Envelope)
	if strings.Join(capabilities.ConversationKinds, ",") != "direct,group,self" || !capabilities.MentionsMe || !capabilities.FromSelf {
		t.Fatalf("capabilities: %+v", capabilities)
	}
	if empty := channels.Capabilities(store.ConnectorEventsEnvelope{Fields: map[string]store.ConnectorEventsValue{"id": {Pointer: "/id"}}}); len(empty.ConversationKinds) != 0 || empty.MentionsMe || empty.FromSelf {
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
	notice := channels.Notice(channel, "OpenLark", "olk im context {message.id} --limit 50",
		channels.Rollover{New: true, Reason: channels.NewIdle, Idle: 6 * time.Hour, Previous: "sess_old", PreviousLast: last}, []store.MessageChannelDeliveryRecord{record})
	for _, want := range []string{
		"channel: mch_x \"工作\"\n", "source: OpenLark\n", "conversation: self oc_me \"我\"\n", "session: new (idle 6h0m0s)\n",
		"earlier session: sess_old (last active 2026-11-13T04:00:00Z)\n", "context: olk im context 1 --limit 50\n",
		"  sender is the person: yes\n", "  attribute replyToMe: true\n", "  rule: dm\n", "  trigger: /ai\n", "  text without trigger: 帮我看下\n",
	} {
		if !strings.Contains(notice, want) {
			t.Errorf("notice lacks %q:\n%s", want, notice)
		}
	}
	continued := channels.Notice(channel, "OpenLark", "", channels.Rollover{}, []store.MessageChannelDeliveryRecord{record})
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
