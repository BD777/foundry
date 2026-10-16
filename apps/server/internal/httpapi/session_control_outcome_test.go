package httpapi

import (
	"errors"
	"testing"
)

func TestNativeSteerUnknownIsNotARefusalToRetry(t *testing.T) {
	payload := wsSessionSteeredPayload{wsReplyError: wsReplyError{Error: "native acknowledgement lost"}, OutcomeUnknown: true}
	var unknown *deviceNoAnswerError
	if !errors.As(payload.refusal(), &unknown) {
		t.Fatal("unknown steer must retain the queue's unconfirmed state")
	}
	payload.OutcomeUnknown = false
	if errors.As(payload.refusal(), &unknown) {
		t.Fatal("an explicit refusal is retryable")
	}
}
