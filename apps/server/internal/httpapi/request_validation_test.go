package httpapi

import (
	"strings"
	"testing"
)

func TestDecodeStrictJSONRejectsUnknownAndTrailingValues(t *testing.T) {
	target := struct {
		Message string `json:"message"`
	}{}

	if err := decodeStrictJSON(
		strings.NewReader(`{"message":"hello","unexpected":true}`),
		&target,
	); err == nil {
		t.Fatal("expected unknown JSON field to be rejected")
	}
	if err := decodeStrictJSON(
		strings.NewReader(`{"message":"hello"} {"message":"again"}`),
		&target,
	); err == nil {
		t.Fatal("expected trailing JSON value to be rejected")
	}
}

func TestValidateWebSocketEnvelopeLimitsFields(t *testing.T) {
	tests := []struct {
		name     string
		envelope wsEnvelope
		wantErr  bool
	}{
		{name: "valid", envelope: wsEnvelope{ID: "msg_1", Type: wsHeartbeatType}},
		{name: "missing type", envelope: wsEnvelope{ID: "msg_1"}, wantErr: true},
		{name: "long type", envelope: wsEnvelope{Type: strings.Repeat("x", 65)}, wantErr: true},
		{
			name:     "long id",
			envelope: wsEnvelope{ID: strings.Repeat("x", 257), Type: wsHeartbeatType},
			wantErr:  true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateWebSocketEnvelope(test.envelope)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateWebSocketEnvelope() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
