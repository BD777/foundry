package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// idempotentRequest dedupes a request by its Idempotency-Key. Requests that
// share a key in a scope run one at a time; a recorded one replays.
type idempotentRequest struct {
	ledger store.RequestLedger
	scope  string
	key    string
	input  any
	unlock func()
}

// beginIdempotentRequest replays a recorded request with this key and input
// (handled), or refuses the key reused with a different input (handled, 409).
// Otherwise the caller runs the request, records its result and releases.
// Without a key the request runs as before.
func (s *Server) beginIdempotentRequest(w http.ResponseWriter, r *http.Request, scope string, input any, replayStatus int) (*idempotentRequest, bool) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	ledger, ok := s.store.(store.RequestLedger)
	if key == "" || !ok {
		return &idempotentRequest{}, false
	}
	if len(key) > 200 {
		writeError(w, http.StatusBadRequest, "Idempotency-Key is too long")
		return nil, true
	}
	request := &idempotentRequest{ledger: ledger, scope: scope, key: key, input: input, unlock: s.lockIdempotencyKey(scope + "\x00" + key)}
	var recorded json.RawMessage
	replayed, err := ledger.ReplayRequest(r.Context(), scope, key, input, &recorded)
	if err != nil || replayed {
		request.release()
		switch {
		case errors.Is(err, store.ErrIdempotencyConflict):
			writeError(w, http.StatusConflict, err.Error())
		case err != nil:
			writeResult(w, nil, err)
		default:
			writeJSON(w, replayStatus, recorded)
		}
		return nil, true
	}
	return request, false
}

func (request *idempotentRequest) record(ctx context.Context, response any) {
	if request.ledger == nil {
		return
	}
	if err := request.ledger.RecordRequest(ctx, request.scope, request.key, request.input, response); err != nil {
		log.Printf("record idempotent request %s: %v", request.scope, err)
	}
}

func (request *idempotentRequest) release() {
	if request.unlock != nil {
		request.unlock()
		request.unlock = nil
	}
}

func (s *Server) lockIdempotencyKey(id string) func() {
	value, _ := s.idempotencyLocks.LoadOrStore(id, &sync.Mutex{})
	mutex := value.(*sync.Mutex)
	mutex.Lock()
	return func() {
		// A request that waited on this mutex finds the recorded result;
		// later ones start from a fresh mutex.
		s.idempotencyLocks.CompareAndDelete(id, mutex)
		mutex.Unlock()
	}
}

// validRequestedInputID refuses an input id a client may not choose (see
// store.ValidSessionInputID); no id lets the store generate one.
func validRequestedInputID(w http.ResponseWriter, id string) bool {
	if id == "" || store.ValidSessionInputID(id) {
		return true
	}
	writeError(w, http.StatusBadRequest, "inputId must be a lowercase UUID")
	return false
}

// sentInput is a direct send that named its input: the session it went to
// ("" when it starts one) and the answer a send gets.
type sentInput struct {
	id          string
	sessionID   string
	workspaceID string
	status      int
}

// replaySentInput answers a send whose input a session already recorded
// with that session, as the first send was answered, so a retry (a lost
// response, a reload) never starts a second turn. It reports whether it
// answered. The same id in another session, workspace or one the caller
// cannot read is refused, never shown.
func (s *Server) replaySentInput(w http.ResponseWriter, r *http.Request, sent sentInput, idempotent *idempotentRequest) bool {
	inputs, ok := s.store.(store.ChatQueueStore)
	if sent.id == "" || !ok {
		return false
	}
	sessionID, found, err := inputs.ChatQueueInputSession(r.Context(), sent.id)
	if err != nil {
		writeResult(w, nil, err)
		return true
	}
	if !found {
		return false
	}
	session, err := store.AgentSessionRecord(r.Context(), s.store, sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return true
	}
	if (sent.sessionID != "" && session.ID != sent.sessionID) || session.WorkspaceID != sent.workspaceID ||
		!s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeError(w, http.StatusConflict, store.ErrSessionInputExists.Error())
		return true
	}
	session = slimAgentSession(session)
	idempotent.record(r.Context(), session)
	writeJSON(w, sent.status, session)
	return true
}
