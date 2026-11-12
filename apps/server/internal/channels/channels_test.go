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
		{"group mention, name of two words", envelope("group", true, false, "@Can Wen /fd 看下"), "group"},
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
}

func newInbox() *inbox {
	return &inbox{entries: map[string]channels.InboxStatus{}, texts: map[string]string{}, keys: map[string]string{}}
}

func (i *inbox) Deliver(ctx context.Context, channel store.MessageChannelRecord, key, messageID, text string) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	id := "inbox_" + messageID
	if _, ok := i.entries[id]; !ok {
		i.entries[id] = channels.InboxStatus{Status: "pending"}
	}
	i.texts[id], i.keys[id] = text, key
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
	st      *sqlitestore.Store
	feed    *feed
	inbox   *inbox
	runner  *channels.Runner
	now     time.Time
	told    []string
	channel store.MessageChannelRecord
}

func newFixture(t *testing.T, limits store.MessageChannelLimits) *fixture {
	t.Helper()
	st, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, feed: &feed{}, inbox: newInbox(), now: time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)}
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
	if len(dropped) != 1 || dropped[0].Envelope.Text != "" || dropped[0].Reason != "no_rule_matched" {
		t.Fatalf("dropped keeps no text: %+v", dropped)
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
			if !strings.Contains(text, "> /fd one") || !strings.Contains(text, "> second line") || !strings.Contains(text, "not the person's words") {
				t.Fatalf("notice: %s", text)
			}
			if strings.Contains(strings.ToLower(text), "you should") || strings.Contains(text, "reply") {
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

func TestSkillFileCarriesTheGuideAndFactsOnly(t *testing.T) {
	channel := store.MessageChannel{ID: "mch_abc123", Name: "飞书 /fd", Guide: "只回答项目相关的问题。", SessionKey: "conversation",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Scope: store.MessageChannelScope{ConnectorDefault: "inherit",
			Connectors: []store.MessageChannelConnectorScope{{AccountID: "xacc_1", Level: "write", Writes: "direct"}}}}
	file := channels.SkillFile(channel, "byte-dev OpenLark", "olk im context {message.id} --limit 50")
	for _, want := range []string{"name: channel-abc123\n", "只回答项目相关的问题。", "olk im context {message.id} --limit 50", "hand_over", "writes go through without asking"} {
		if !strings.Contains(file, want) {
			t.Errorf("skill lacks %q:\n%s", want, file)
		}
	}
	if !strings.HasPrefix(file, "---\nname: channel-abc123\ndescription: \"") {
		t.Fatalf("frontmatter: %s", file[:80])
	}
}
