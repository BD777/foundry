package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type targetAuthorizationStore struct {
	Backend
	session store.AgentSession
	err     error
	readID  string
}

func (s *targetAuthorizationStore) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	s.readID = id
	return s.session, s.err
}

func TestDaemonTargetAuthorizationPreservesReadFailure(t *testing.T) {
	busy := errors.New("database is locked")
	malformed := &json.SyntaxError{Offset: 7}
	for _, tc := range []struct {
		name      string
		err       error
		device    string
		permanent bool
	}{
		{"same device", nil, "dev_a", false},
		{"foreign device", nil, "dev_b", true},
		{"missing", store.ErrNotFound, "", true},
		{"canceled", context.Canceled, "", false},
		{"deadline", context.DeadlineExceeded, "", false},
		{"busy", busy, "", false},
		{"invalid stored JSON", malformed, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backing := &targetAuthorizationStore{session: store.AgentSession{DeviceID: tc.device}, err: tc.err}
			c := &daemonConnection{hub: &DaemonHub{store: backing}, actor: Actor{Kind: ActorDaemon, DeviceID: "dev_a"}}
			envelope := wsEnvelope{Type: wsSessionCompleteType, ID: "envelope_a", Payload: json.RawMessage(`{"sessionId":"sess_a","inputId":"input_a","response":"private answer must not appear"}`)}
			err := c.authorizeTarget(context.Background(), envelope)
			if backing.readID != "sess_a" {
				t.Fatalf("read session = %q", backing.readID)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost failure identity: %v", err)
			}
			if tc.err != nil && errors.Is(err, errForeignTarget) {
				t.Fatalf("read failure became device mismatch: %v", err)
			}
			if tc.err == nil && tc.device == "dev_a" && err != nil {
				t.Fatal(err)
			}
			if tc.err == nil && tc.device != "dev_a" && !errors.Is(err, errForeignTarget) {
				t.Fatalf("foreign target allowed: %v", err)
			}
			if refusedForGood(envelope.Type, err) != tc.permanent {
				t.Fatalf("permanent refusal = %v: %v", !tc.permanent, err)
			}
			if err != nil && (!strings.Contains(err.Error(), "sess_a") || !strings.Contains(err.Error(), "input_a") || strings.Contains(err.Error(), "private answer")) {
				t.Fatalf("unsafe or uncorrelated error: %v", err)
			}
		})
	}
}

func TestDaemonTargetAuthorizationUsesNestedEventSession(t *testing.T) {
	backing := &targetAuthorizationStore{session: store.AgentSession{DeviceID: "dev_a"}}
	c := &daemonConnection{hub: &DaemonHub{store: backing}, actor: Actor{Kind: ActorDaemon, DeviceID: "dev_a"}}
	err := c.authorizeTarget(context.Background(), wsEnvelope{Type: wsSessionEventType, Payload: json.RawMessage(`{"sessionId":"wrong","event":{"sessionId":"sess_a"}}`)})
	if err != nil || backing.readID != "sess_a" {
		t.Fatalf("event target = %q: %v", backing.readID, err)
	}
}
