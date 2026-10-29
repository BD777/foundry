package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A person's message can enter a running turn (DEV-082): boundary at the
// turn's next step, interrupt at once. The server holds both in the chat's
// queue until then, so the person can still change, edit or withdraw one,
// and a turn that ends first starts the next with it. A step is a tool
// call: the model waits on its result, and a message steered in then is
// read with that result. Codex preempts the response it is generating for
// any steer, so a boundary message waits until a tool has run for a
// moment (as the worker does for agents, DEV-057); Claude queues a steer
// for its next tool round itself, so a running tool is enough.

// chatBoundarySettle is how long a Codex tool runs before its response has
// surely finished streaming.
const chatBoundarySettle = time.Second

// chatSteerPumpInterval is how often held messages are looked at without
// an event: an interrupt the turn could not take yet, a boundary past its
// limit.
const chatSteerPumpInterval = 3 * time.Second

// chatSteerWatch follows the tools sessions run and the chats whose queue
// holds a message for a running turn.
type chatSteerWatch struct {
	mu sync.Mutex
	// running: session → tool call → when it started.
	running map[string]map[string]time.Time
	// settle: session → the wait for its running tool's response to end.
	settle map[string]*time.Timer
	// armed: the chats with boundary or interrupt messages queued.
	armed map[store.ChatQueueRef]bool
	// chats: session → its chat, once looked up.
	chats map[string]store.ChatQueueRef
}

func (w *chatSteerWatch) init() {
	if w.running == nil {
		w.running = map[string]map[string]time.Time{}
		w.settle = map[string]*time.Timer{}
		w.armed = map[store.ChatQueueRef]bool{}
		w.chats = map[string]store.ChatQueueRef{}
	}
}

func (w *chatSteerWatch) arm(ref store.ChatQueueRef) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.init()
	w.armed[ref] = true
}

// toolStartedAt is when the session's longest running tool started.
func (w *chatSteerWatch) toolStartedAt(sessionID string) (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	earliest, found := time.Time{}, false
	for _, at := range w.running[sessionID] {
		if !found || at.Before(earliest) {
			earliest, found = at, true
		}
	}
	return earliest, found
}

// ended forgets what the session ran: its turn is over.
func (w *chatSteerWatch) ended(sessionID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.init()
	delete(w.running, sessionID)
	delete(w.chats, sessionID)
	if timer := w.settle[sessionID]; timer != nil {
		timer.Stop()
		delete(w.settle, sessionID)
	}
}

// toolEvent records a tool's start or end. It reports whether a boundary
// may have opened for an armed chat: a tool started (open) or one ended
// while its settle was pending (settled).
func (w *chatSteerWatch) toolEvent(event store.AgentSessionEvent, now time.Time) (started, settled bool) {
	message := event.Message
	if message == nil || message.Kind != "tool" {
		return false, false
	}
	call := strings.TrimSpace(message.CallID)
	if call == "" {
		call = strings.TrimSpace(message.ID)
	}
	if call == "" {
		return false, false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.init()
	switch message.Status {
	case "running":
		calls := w.running[event.SessionID]
		if calls == nil {
			calls = map[string]time.Time{}
			w.running[event.SessionID] = calls
		}
		if _, known := calls[call]; known {
			// The same call again, with its input: still running.
			return false, false
		}
		calls[call] = now
		return true, false
	case "completed", "failed":
		calls := w.running[event.SessionID]
		if _, known := calls[call]; !known {
			return false, false
		}
		delete(calls, call)
		if len(calls) == 0 {
			delete(w.running, event.SessionID)
		}
		if timer := w.settle[event.SessionID]; timer != nil {
			// Done before its response settled: its next request starts
			// now, the earliest point left in the turn.
			timer.Stop()
			delete(w.settle, event.SessionID)
			return false, true
		}
	}
	return false, false
}

// schedule runs place once after delay, unless one is pending for the
// session already.
func (w *chatSteerWatch) schedule(sessionID string, delay time.Duration, place func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.init()
	if w.settle[sessionID] != nil {
		return
	}
	w.settle[sessionID] = time.AfterFunc(delay, func() {
		w.mu.Lock()
		delete(w.settle, sessionID)
		w.mu.Unlock()
		place()
	})
}

// armedChat is the session's chat when its queue holds a message for a
// running turn; lookup finds the chat of a session not seen yet.
func (w *chatSteerWatch) armedChat(sessionID string, lookup func() (store.ChatQueueRef, bool)) (store.ChatQueueRef, bool) {
	w.mu.Lock()
	w.init()
	if len(w.armed) == 0 {
		w.mu.Unlock()
		return store.ChatQueueRef{}, false
	}
	ref, known := w.chats[sessionID]
	w.mu.Unlock()
	if !known {
		var found bool
		if ref, found = lookup(); !found {
			return store.ChatQueueRef{}, false
		}
		w.mu.Lock()
		w.chats[sessionID] = ref
		w.mu.Unlock()
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return ref, w.armed[ref]
}

// replaceArmed sets the armed chats to those the store lists.
func (w *chatSteerWatch) replaceArmed(refs []store.ChatQueueRef) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.init()
	w.armed = map[store.ChatQueueRef]bool{}
	for _, ref := range refs {
		w.armed[ref] = true
	}
}

// chatSteerTrigger is why held messages are looked at.
type chatSteerTrigger int

const (
	// chatSteerChanged: a message was queued or changed.
	chatSteerChanged chatSteerTrigger = iota
	// chatSteerBoundary: the running turn reached a step.
	chatSteerBoundary
	// chatSteerPump: the periodic look.
	chatSteerPump
)

// onChatToolEvent follows a session's tools; one that starts or ends may
// open the boundary a held message waits for.
func (s *Server) onChatToolEvent(event store.AgentSessionEvent) {
	started, settled := s.chatSteers.toolEvent(event, time.Now())
	if !started && !settled {
		return
	}
	ref, armed := s.chatSteers.armedChat(event.SessionID, func() (store.ChatQueueRef, bool) {
		session, err := s.store.GetAgentSessionSummary(context.Background(), event.SessionID)
		if err != nil || session.Role != "" || (session.Source != "" && session.Source != "chat") {
			return store.ChatQueueRef{}, false
		}
		chatID := session.ThreadID
		if chatID == "" {
			chatID = session.ID
		}
		return store.ChatQueueRef{WorkspaceID: session.WorkspaceID, ChatID: chatID}, true
	})
	if !armed {
		return
	}
	s.kickChatSteers(ref, chatSteerBoundary, settled)
}

// kickChatSteers places the chat's held messages in the background.
// settled: a boundary that needs no settle (a tool just ended).
func (s *Server) kickChatSteers(ref store.ChatQueueRef, trigger chatSteerTrigger, settled bool) {
	s.chatQueueKicks.Add(1)
	go func() {
		defer s.chatQueueKicks.Done()
		s.placeChatSteers(context.Background(), ref, trigger, settled)
	}()
}

// placeChatSteers steers the chat's held messages that are due into its
// running turn: interrupt ones at once, boundary ones at a step or past
// their limit. A turn not running leaves them queued: the next turn starts
// with them.
func (s *Server) placeChatSteers(ctx context.Context, ref store.ChatQueueRef, trigger chatSteerTrigger, settled bool) {
	queue, err := s.store.ChatQueue(ctx, ref.WorkspaceID, ref.ChatID)
	if err != nil {
		return
	}
	held := []store.ChatQueueItem{}
	for _, item := range queue.Items {
		if item.State == store.ChatQueueStateQueued && item.Delivery != "" {
			held = append(held, item)
		}
	}
	if len(held) == 0 {
		return
	}
	session, found, active, err := s.store.ChatQueueSession(ctx, ref.WorkspaceID, ref.ChatID)
	if err != nil || !found || !active {
		return
	}
	// A step: a tool just ended, or one runs (for Codex, long enough that
	// its response has finished).
	boundary := settled
	if startedAt, running := s.chatSteers.toolStartedAt(session.ID); running && !boundary {
		wait := time.Duration(0)
		if session.Provider == "codex" {
			wait = chatBoundarySettle - time.Since(startedAt)
		}
		if wait > 0 {
			s.chatSteers.schedule(session.ID, wait, func() {
				s.kickChatSteers(ref, chatSteerBoundary, true)
			})
		} else {
			boundary = true
		}
	}
	now := time.Now()
	for _, item := range held {
		due := item.Delivery == store.DeliveryInterrupt || boundary
		if !due && item.FallbackAt != "" {
			if fallback, err := time.Parse(time.RFC3339Nano, item.FallbackAt); err == nil && !now.Before(fallback) {
				due = true
			}
		}
		if !due {
			continue
		}
		steered, err := s.steerChatQueueItem(ctx, ref.WorkspaceID, ref.ChatID, item.ID, store.DeliveryInterrupt)
		if err == nil {
			s.chats.queueChanged(steered)
			continue
		}
		var refused *chatSteerRefusal
		if errors.As(err, &refused) && strings.Contains(refused.message, "does not support steering") {
			// This runtime takes no message mid-turn: it waits for the turn
			// to end, and the row says so.
			s.waitForTurnEnd(ctx, ref, item.ID)
			continue
		}
		if trigger != chatSteerPump {
			log.Printf("chat message %s waits for the turn: %v", item.ID, err)
		}
		// The turn cannot take input now (starting, finishing, compacting):
		// the next event or look tries again.
		return
	}
}

// waitForTurnEnd makes a held message wait for the turn to end.
func (s *Server) waitForTurnEnd(ctx context.Context, ref store.ChatQueueRef, itemID string) {
	queue, err := s.store.ChatQueue(ctx, ref.WorkspaceID, ref.ChatID)
	if err != nil {
		return
	}
	for _, item := range queue.Items {
		if item.ID != itemID {
			continue
		}
		none, revision := "", item.Revision
		changed, err := s.store.EditChatQueueItem(ctx, ref.WorkspaceID, ref.ChatID, itemID, store.EditChatQueueItemInput{Delivery: &none, ExpectedRevision: &revision})
		if err == nil {
			s.chats.queueChanged(changed)
		}
	}
}

// RunChatQueueSteers looks at the held messages of every chat until ctx
// ends; events place them sooner.
func (s *Server) RunChatQueueSteers(ctx context.Context) {
	ticker := time.NewTicker(chatSteerPumpInterval)
	defer ticker.Stop()
	for {
		refs, err := s.store.ChatQueuesAwaitingSteer(ctx)
		if err == nil {
			s.chatSteers.replaceArmed(refs)
			for _, ref := range refs {
				s.placeChatSteers(ctx, ref, chatSteerPump, false)
			}
		} else if ctx.Err() == nil {
			log.Printf("list chat messages held for a running turn: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
