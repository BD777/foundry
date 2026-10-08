package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const maxJSONRequestBytes = 1 << 20

func decodeJSONRequest(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONRequestBytes)
	if err := decodeStrictJSON(r.Body, target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON request body")
		return false
	}
	return true
}

// decodeWebSocketPayload reads a worker's message. Workers run older or
// newer builds than the server while they update, so a field this server
// does not know is ignored rather than refused: refusing it took every
// worker that still reported a removed field offline.
func decodeWebSocketPayload(payload json.RawMessage, target any) error {
	if len(payload) == 0 {
		return errors.New("websocket message payload is required")
	}
	return decodeJSON(bytes.NewReader(payload), target, false)
}

func decodeWebSocketEnvelope(message []byte, target any) error {
	return decodeStrictJSON(bytes.NewReader(message), target)
}

func validateWebSocketEnvelope(envelope wsEnvelope) error {
	if envelope.Type == "" {
		return errors.New("websocket message type is required")
	}
	if len(envelope.Type) > 64 {
		return errors.New("websocket message type is too long")
	}
	if len(envelope.ID) > 256 {
		return errors.New("websocket message id is too long")
	}
	if len(envelope.Error) > 8*1024 {
		return errors.New("websocket message error is too long")
	}
	return nil
}

func decodeStrictJSON(reader io.Reader, target any) error {
	return decodeJSON(reader, target, true)
}

func decodeJSON(reader io.Reader, target any, strict bool) error {
	decoder := json.NewDecoder(reader)
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}
