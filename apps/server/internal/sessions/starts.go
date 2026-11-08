package sessions

import "sync"

// starts tracks the sessions their starter (CreateAndDispatch, Send) is
// still handing to their device. The starter runs BeforeDispatch (or
// beforeDelivery) before the device hears of the session, so the sweep of
// a device's queued sessions on hello (httpapi's
// dispatchQueuedAgentSessions) waits for it first (AwaitStart): the store
// shows the session queued from the moment it is created.
type starts struct {
	// creating is held shared from before a session is created until it is
	// in pending, so a sweep that listed the session finds it there.
	creating sync.RWMutex
	mu       sync.Mutex
	pending  map[string]*start
}

type start struct {
	starters int
	done     chan struct{}
}

func (s *starts) begin(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending == nil {
		s.pending = map[string]*start{}
	}
	current := s.pending[sessionID]
	if current == nil {
		current = &start{done: make(chan struct{})}
		s.pending[sessionID] = current
	}
	current.starters++
}

func (s *starts) end(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.pending[sessionID]
	if current == nil {
		return
	}
	if current.starters--; current.starters == 0 {
		close(current.done)
		delete(s.pending, sessionID)
	}
}

// AwaitStart waits until no starter is handing the session to its device
// any more, and reports whether one was: the session may have been sent,
// failed or left waiting for its device meanwhile.
func (s *Service) AwaitStart(sessionID string) bool {
	// Waits out the sessions being created.
	s.starts.creating.Lock()
	s.starts.creating.Unlock()
	s.starts.mu.Lock()
	current := s.starts.pending[sessionID]
	s.starts.mu.Unlock()
	if current == nil {
		return false
	}
	<-current.done
	return true
}
