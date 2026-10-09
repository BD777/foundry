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
