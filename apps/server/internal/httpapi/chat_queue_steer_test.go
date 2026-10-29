package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (d *queueDaemon) steeredTexts() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	texts := []string{}
	for _, steer := range d.steered {
		texts = append(texts, steer.Message)
	}
	return texts
}

func (d *queueDaemon) toolEvent(sessionID, callID, status string) {
	d.write("tool_"+callID+"_"+status, wsSessionEventType, map[string]any{"event": map[string]any{
		"id": "evt_tool_" + callID + "_" + status, "sessionId": sessionID, "label": "Running command", "level": "info",
		"message": map[string]any{"id": callID, "kind": "tool", "callId": callID, "status": status, "text": "sleep 5"},
	}})
}

// A person's message sent during a turn waits on the server for its
// delivery (DEV-082): boundary until a tool runs (Codex: for a moment),
// interrupt at once, turn_end for the next turn. Until it goes in the
// person can change or withdraw it, and a turn that ends first starts the
// next with it.
func TestChatQueueDeliveryModes(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			backing := newEmptyTestStore(t)
			ctx := context.Background()
			registerQueueDevice(t, backing, provider)
			session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
				WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: provider, Prompt: "running", Source: "chat",
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
				t.Fatal(err)
			}
			server := NewServer(backing)
			live := httptest.NewServer(server.Routes())
			defer live.Close()
			client := queueClient{t: t, server: server, url: live.URL}
			daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", provider, []string{session.ID}, "codex_active_steer")
			path := "/api/chats/" + session.ID + "/queue"

			if status, raw := client.call(http.MethodPost, path, `{"text":"x","delivery":"later"}`, ""); status != http.StatusBadRequest {
				t.Fatalf("unknown delivery = %d %s", status, raw)
			}

			// Boundary: held while the model generates.
			queue := client.queue(http.MethodPost, path, `{"text":"at the next step","delivery":"boundary"}`, "", http.StatusCreated)
			held := queue.Items[0]
			if held.Delivery != store.DeliveryBoundary || held.DeliverySince == "" || held.FallbackAt == "" {
				t.Fatalf("boundary message = %+v", held)
			}
			since, _ := time.Parse(time.RFC3339Nano, held.DeliverySince)
			fallback, _ := time.Parse(time.RFC3339Nano, held.FallbackAt)
			if fallback.Sub(since) != store.ChatBoundaryLimit {
				t.Fatalf("fallback %v after %v", fallback, since)
			}
			time.Sleep(200 * time.Millisecond)
			if got := daemon.steeredTexts(); len(got) != 0 {
				t.Fatalf("steered before any step: %v", got)
			}

			// The person withdraws it, then sends another: it stays theirs to
			// change until it goes in.
			client.queue(http.MethodDelete, path+"/"+held.ID, "", "", http.StatusOK)
			queue = client.queue(http.MethodPost, path, `{"text":"after this turn"}`, "", http.StatusCreated)
			queue = client.queue(http.MethodPost, path, `{"text":"boundary two","delivery":"boundary"}`, "", http.StatusCreated)
			if len(queue.Items) != 2 || queue.Items[0].Delivery != "" {
				t.Fatalf("queue = %+v", queue.Items)
			}

			// A tool starts: Claude takes it at once, Codex once the tool ran
			// for a moment.
			started := time.Now()
			daemon.toolEvent(session.ID, "call_1", "running")
			waitForTest(t, "the boundary message to go in", func() bool {
				got := daemon.steeredTexts()
				return len(got) == 1 && got[0] == "boundary two"
			})
			waited := time.Since(started)
			if provider == "codex" && waited < chatBoundarySettle-100*time.Millisecond {
				t.Fatalf("codex steered %v after the tool started, before it settled", waited)
			}
			if provider == "claude" && waited > chatBoundarySettle {
				t.Fatalf("claude steered %v after the tool started", waited)
			}
			daemon.toolEvent(session.ID, "call_1", "completed")

			// The turn_end message switches to interrupt: it goes in at once.
			waitForTest(t, "the steered message to leave the queue", func() bool {
				queue = client.queue(http.MethodGet, path, "", "", http.StatusOK)
				got := queueTextsOf(queue)
				return len(got) == 1 && got[0] == "after this turn"
			})
			item := queue.Items[0]
			client.queue(http.MethodPatch, path+"/"+item.ID, `{"delivery":"interrupt","expectedRevision":`+strconv.FormatInt(item.Revision, 10)+`}`, "", http.StatusOK)
			waitForTest(t, "the interrupt message to go in", func() bool {
				return len(daemon.steeredTexts()) == 2
			})

			// A boundary message whose turn ends first starts the next turn,
			// ahead of one queued before it for the turn's end.
			client.queue(http.MethodPost, path, `{"text":"next turn"}`, "", http.StatusCreated)
			client.queue(http.MethodPost, path, `{"text":"held at the end","delivery":"boundary"}`, "", http.StatusCreated)
			daemon.complete(session, "done")
			runs := daemon.waitForRuns(1)
			if runs[0].Input.Prompt != "held at the end" {
				t.Fatalf("next turn = %+v", runs[0].Input)
			}
			if got := daemon.steeredTexts(); len(got) != 2 {
				t.Fatalf("steered after the turn = %v", got)
			}
		})
	}
}

// A runtime that takes no message mid-turn makes a held message wait for
// the turn's end, and says so.
func TestChatQueueDeliveryWithoutSteering(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "running", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	client := queueClient{t: t, server: server, url: live.URL}
	// No codex_active_steer: this device cannot steer Codex.
	connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "codex", []string{session.ID})
	path := "/api/chats/" + session.ID + "/queue"
	client.queue(http.MethodPost, path, `{"text":"now please","delivery":"interrupt"}`, "", http.StatusCreated)
	waitForTest(t, "the message to wait for the turn's end", func() bool {
		queue := client.queue(http.MethodGet, path, "", "", http.StatusOK)
		return len(queue.Items) == 1 && queue.Items[0].Delivery == "" && queue.Items[0].State == store.ChatQueueStateQueued
	})
}
