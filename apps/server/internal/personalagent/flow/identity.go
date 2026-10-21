// Package flow contains deterministic Personal Agent workflow rules. It never
// calls a model or starts work: the HTTP service and transactional store apply
// the same identities and validation before recording or dispatching work.
package flow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Key separates every component, including its length, through JSON encoding.
// It names a logical operation, not an attempt. A retry must keep its key.
func Key(kind string, parts ...string) string {
	data, _ := json.Marshal(append([]string{kind}, parts...))
	sum := sha256.Sum256(data)
	return kind + "_" + hex.EncodeToString(sum[:16])
}

// InputID gives a logical operation a stable UUID accepted by both native
// runtimes. The store's existing global input uniqueness is the final fence
// against an outbox retry creating another session after a lost response.
func InputID(operationID string) string {
	return store.WorkRunInputID("personal-agent", operationID)
}

// Capture validates an authenticated channel's envelope. A model cannot
// choose its user or channel identity; callers supply those from the actor.
func Capture(userID, channel, messageID, text string) error {
	if strings.TrimSpace(userID) == "" {
		return fmt.Errorf("an inbox message requires an authenticated person")
	}
	if channel != "web" && channel != "feishu" {
		return fmt.Errorf("unsupported inbox channel")
	}
	if strings.TrimSpace(messageID) == "" || len(messageID) > 200 {
		return fmt.Errorf("messageId is required and must be at most 200 bytes")
	}
	if strings.TrimSpace(text) == "" || !utf8.ValidString(text) || len(text) > 128*1024 {
		return fmt.Errorf("text must be nonempty UTF-8 and at most 128 KiB")
	}
	return nil
}

// Fingerprint is used to detect a reused operation key with changed intent.
// The caller passes a typed struct, so untrusted object key order cannot
// change the result. User content is never included in the returned identity.
func Fingerprint(value any) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}
