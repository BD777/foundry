package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// followUpFeed answers the channel's polls from a script.
type followUpFeed struct {
	mu      sync.Mutex
	answers []any
	wake    chan struct{}
	// pollPath is the descriptor's poll path; other paths are reads (the
	// thread root and earlier replies), answered empty without a queued poll.
	pollPath string
}

func (f *followUpFeed) push(answer any) {
	f.mu.Lock()
	f.answers = append(f.answers, answer)
	f.mu.Unlock()
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

func (f *followUpFeed) Get(ctx context.Context, path string, query url.Values) (int, []byte, http.Header, error) {
	if f.pollPath != "" && path != f.pollPath {
		return http.StatusOK, []byte("{}"), http.Header{}, nil
	}
	for {
		f.mu.Lock()
		if len(f.answers) > 0 {
			body := f.answers[0]
			f.answers = f.answers[1:]
			f.mu.Unlock()
			raw, _ := json.Marshal(body)
			return http.StatusOK, raw, http.Header{}, nil
		}
		f.mu.Unlock()
		select {
		case <-ctx.Done():
			return 0, nil, nil, ctx.Err()
		case <-f.wake:
		}
	}
}

func (f *followUpFeed) empty() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.answers) == 0
}

// followUpInbox records the turns and lets the test end them.
type followUpInbox struct {
	mu     sync.Mutex
	status map[string]channels.InboxStatus
	turns  map[string]channels.Turn
}

func (i *followUpInbox) Deliver(ctx context.Context, channel store.MessageChannelRecord, turn channels.Turn) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	id := "inbox_" + turn.MessageID
	i.turns[id] = turn
	i.status[id] = channels.InboxStatus{Status: "pending"}
	return id, nil
}

func (i *followUpInbox) Status(ctx context.Context, assistantID, inboxID string) (channels.InboxStatus, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	status, ok := i.status[inboxID]
	if !ok {
		return status, store.ErrNotFound
	}
	return status, nil
}

func (i *followUpInbox) resolve(sessionID string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	for id := range i.status {
		i.status[id] = channels.InboxStatus{Status: "resolved", SessionID: sessionID, ResultStatus: "completed"}
	}
}

func (i *followUpInbox) delivered() []channels.Turn {
	i.mu.Lock()
	defer i.mu.Unlock()
	out := make([]channels.Turn, 0, len(i.turns))
	for _, turn := range i.turns {
		out = append(out, turn)
	}
	return out
}

// followUpSpec is the bundled OpenLark feed mapping.
func followUpSpec(t *testing.T) store.ConnectorEventsSpec {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "extensions", "open-lark", "foundry-extension.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Connectors []store.ConnectorDescriptor `json:"connectors"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil || manifest.Connectors[0].ServerHeld.Events == nil {
		t.Fatalf("the OpenLark extension declares no events: %v", err)
	}
	return *manifest.Connectors[0].ServerHeld.Events
}

// followUpChange is one change of OpenLark's GET /agent/v1/changes.
func followUpChange(id, text string) map[string]any {
	return map[string]any{
		"seq": 7, "at": 1794500000000, "kind": "message", "op": "new", "feedId": "oc_g", "id": id,
		"item": map[string]any{
			"id": "msg:" + id, "source": "chats", "kind": "message", "time": 1794500000000,
			"author": map[string]any{"id": "ou_peer", "name": "张三"},
			"where":  map[string]any{"id": "oc_g", "name": "项目群", "kind": "group"},
			"text":   text, "signals": map[string]any{"atMe": true},
			"thread": map[string]any{"id": "th_1", "reply": true},
		},
	}
}

func followUpChanges(cursor string, items ...map[string]any) map[string]any {
	list := make([]any, 0, len(items))
	for _, item := range items {
		list = append(list, item)
	}
	return map[string]any{"cursor": cursor, "more": false, "changes": list}
}

// A trigger and then a message of the same thread without a trigger start
// and continue one channel session, and the deliveries API shows both.
func TestFollowUpInTheSameThreadContinuesTheChannelSession(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	agent, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, WorkspaceID: "ws_alice", HomeDeviceID: "dev_alice", Settings: personalagent.DefaultSettings(),
	})
	if err != nil {
		t.Fatal(err)
	}
	channel := store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{
		ID: "mch_http", AssistantID: agent.ID, Name: "Lark /fd", Enabled: true, SessionKey: "thread",
		Source:  store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_lark"},
		Filters: store.MessageChannelFilters{Rules: []store.MessageChannelRule{{ID: "group", Enabled: true, ConversationKinds: []string{"group"}, MentionsMe: "yes", FromSelf: "no", TextPrefixes: []string{"/fd"}}}},
		Limits:  store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := f.db.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	feed, inbox := &followUpFeed{wake: make(chan struct{}, 1), pollPath: followUpSpec(t).Poll.Path}, &followUpInbox{status: map[string]channels.InboxStatus{}, turns: map[string]channels.Turn{}}
	now := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	runner := channels.NewRunner(channels.Ports{
		Store: f.db,
		Open: func(context.Context, store.MessageChannelRecord) (channels.Source, error) {
			return channels.LongPoll{Spec: followUpSpec(t), Upstream: feed}, nil
		},
		Inbox: inbox,
		ReplyCommand: func(context.Context, store.MessageChannelRecord, string) string {
			return "olk im reply {message.id} --thread"
		},
		Now: func() time.Time { return now },
	})
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); runner.Run(runCtx) }()
	t.Cleanup(func() { cancel(); <-done })
	poll := func(cursor string, change map[string]any) {
		t.Helper()
		feed.push(followUpChanges(cursor, change))
		deadline := time.Now().Add(10 * time.Second)
		for !feed.empty() {
			if time.Now().After(deadline) {
				t.Fatal("the runner did not read the feed")
			}
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(300 * time.Millisecond)
		now = now.Add(channels.Debounce + time.Second)
		runner.Dispatch(ctx)
	}

	poll("c1", followUpChange("m1", "@邓灿文 /fd 看下这个"))
	inbox.resolve("sess_1")
	runner.Dispatch(ctx)
	poll("c2", followUpChange("m2", "接着说"))

	turns := inbox.delivered()
	if len(turns) != 2 {
		t.Fatalf("two turns: %d", len(turns))
	}
	for _, turn := range turns {
		if turn.SessionKey != "c:oc_g|t:th_1" || turn.InboxChannel != turns[0].InboxChannel {
			t.Fatalf("the follow-up continues the thread's session: %+v", turn)
		}
	}
	var list store.MessageChannelDeliveryList
	f.call(f.alice, http.MethodGet, "/api/personal-agent/channels/"+channel.ID+"/deliveries", "", http.StatusOK, "deliveries", &list)
	if len(list.Deliveries) != 2 {
		t.Fatalf("the API lists both: %+v", list.Deliveries)
	}
	var trigger, follow *store.MessageChannelDelivery
	for i := range list.Deliveries {
		switch list.Deliveries[i].Envelope.MessageID {
		case "m1":
			trigger = &list.Deliveries[i]
		case "m2":
			follow = &list.Deliveries[i]
		}
	}
	if trigger == nil || follow == nil || trigger.Rule != "group" || follow.Rule != channels.RuleFollowUp {
		t.Fatalf("the API shows the trigger and the follow-up: %+v", list.Deliveries)
	}
	if follow.SessionKey != trigger.SessionKey || follow.Segment != trigger.Segment {
		t.Fatalf("same session: trigger %+v follow-up %+v", trigger, follow)
	}
}
