package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The official subscriptions' sign-in on a device, for its owner: the
// device's CLI signs in to its own configuration (its egress, its token
// exchange); the server only relays the page, the one-time code, and the
// code the person pastes back. The routes mirror a device connector's
// sign-in so the Web drives both the same way: begin takes the browser's
// requestId (the same id returns the same running sign-in) and answers an
// operationId the other steps name.

// nativeSignInRequests remembers which sign-in a browser's requestId began,
// per owner, device and runtime, for as long as such a sign-in can run.
type nativeSignInRequests struct {
	mu      sync.Mutex
	entries map[string]nativeSignInRequest
}

type nativeSignInRequest struct {
	operationID string
	expires     time.Time
}

const nativeSignInLifetime = 16 * time.Minute

// operation returns the sign-in requestID began, minting one the first time.
func (n *nativeSignInRequests) operation(key string) (string, bool, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	for k, entry := range n.entries {
		if now.After(entry.expires) {
			delete(n.entries, k)
		}
	}
	if entry, ok := n.entries[key]; ok {
		return entry.operationID, true, nil
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", false, err
	}
	operationID := "nsi_" + hex.EncodeToString(raw[:])
	if n.entries == nil {
		n.entries = map[string]nativeSignInRequest{}
	}
	n.entries[key] = nativeSignInRequest{operationID: operationID, expires: now.Add(nativeSignInLifetime)}
	return operationID, false, nil
}

func (s *Server) handleBeginNativeSignIn(w http.ResponseWriter, r *http.Request) {
	deviceID, runtime, ok := s.deviceAccountTarget(w, r)
	if !ok {
		return
	}
	var input store.NativeSignInInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.RequestID == "" || len(input.RequestID) > 100 {
		writeError(w, http.StatusBadRequest, "sign-in request ID is required")
		return
	}
	owner := actorFromContext(r.Context()).AccountID()
	operationID, running, err := s.nativeSignIns.operation(owner + "\x00" + deviceID + "\x00" + runtime + "\x00" + input.RequestID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	action := store.NativeSignInActionBegin
	if running {
		action = store.NativeSignInActionPoll
	}
	s.nativeSignInStep(w, r, deviceID, store.NativeSignInRequestPayload{Runtime: runtime, Action: action, OperationID: operationID})
}

func (s *Server) handlePollNativeSignIn(w http.ResponseWriter, r *http.Request) {
	s.nativeSignInOperation(w, r, store.NativeSignInActionPoll)
}

func (s *Server) handleNativeSignInCode(w http.ResponseWriter, r *http.Request) {
	s.nativeSignInOperation(w, r, store.NativeSignInActionInput)
}

func (s *Server) handleDismissNativeSignIn(w http.ResponseWriter, r *http.Request) {
	s.nativeSignInOperation(w, r, store.NativeSignInActionDismiss)
}

func (s *Server) nativeSignInOperation(w http.ResponseWriter, r *http.Request, action store.NativeSignInAction) {
	deviceID, runtime, ok := s.deviceAccountTarget(w, r)
	if !ok {
		return
	}
	var input store.NativeSignInInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.OperationID == "" || len(input.OperationID) > 100 {
		writeError(w, http.StatusBadRequest, "sign-in operation ID is required")
		return
	}
	if action == store.NativeSignInActionInput && (input.Code == "" || len(input.Code) > 4096) {
		writeError(w, http.StatusBadRequest, "paste the code the sign-in page showed")
		return
	}
	s.nativeSignInStep(w, r, deviceID, store.NativeSignInRequestPayload{Runtime: runtime, Action: action, OperationID: input.OperationID, Input: input.Code})
}

func (s *Server) handleNativeSignOut(w http.ResponseWriter, r *http.Request) {
	deviceID, runtime, ok := s.deviceAccountTarget(w, r)
	if !ok {
		return
	}
	if _, err := s.hub.NativeSignIn(r.Context(), deviceID, store.NativeSignInRequestPayload{Runtime: runtime, Action: store.NativeSignInActionSignOut}); err != nil {
		writeNativeSignInError(w, err)
		return
	}
	writeResult(w, struct{}{}, nil)
}

func (s *Server) nativeSignInStep(w http.ResponseWriter, r *http.Request, deviceID string, request store.NativeSignInRequestPayload) {
	step, err := s.hub.NativeSignIn(r.Context(), deviceID, request)
	if err != nil {
		writeNativeSignInError(w, err)
		return
	}
	if step == nil {
		step = &store.NativeSignInStep{Status: "expired", OperationID: request.OperationID}
	}
	writeResult(w, step, nil)
}

func writeNativeSignInError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "device disconnected")
		return
	}
	writeResult(w, nil, err)
}

// NativeSignIn hands one sign-in step to the device. A sign-in that
// completed, or a sign-out, comes back with the device's fresh
// registration, so its local login shows at once.
func (h *DaemonHub) NativeSignIn(ctx context.Context, deviceID string, request store.NativeSignInRequestPayload) (*store.NativeSignInStep, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	// Beginning waits for the CLI to show its page (the worker gives up at 30 s).
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	value, err := daemonRequest[store.NativeSignInReplyPayload](ctx, connection, wsNativeSignInType, payload)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	if value.Registration != nil && value.Registration.Device.ID != "" {
		if err := connection.syncRegistration(*value.Registration); err != nil {
			return nil, err
		}
	}
	return value.SignIn, nil
}
