package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Codex async question is held under its message id, "<turn input>/<call
// id>". The reply that answers it names the call id the runtime matches.
func TestCodexAsyncQuestionItemNamesTheRuntimeCallID(t *testing.T) {
	event := store.AgentSessionEvent{
		ID:        "evt_async",
		SessionID: "sess_helper",
		Message: &store.TranscriptMessage{
			ID:        "input-1/call_7aa",
			Kind:      "assistant",
			Delivery:  "async",
			Questions: []store.AgentQuestion{{Title: "a.txt or b.txt?", Options: []string{"a.txt", "b.txt"}}},
		},
	}
	items := pendingItemsFromEvent(event, false)
	if len(items) != 1 || items[0].MessageID != "input-1/call_7aa" {
		t.Fatalf("items = %+v, want one held under input-1/call_7aa", items)
	}

	reply := strings.TrimSpace(agentQuestionReplyText(items[0].MessageID, "a.txt or b.txt?", "b.txt"))
	body := strings.TrimSuffix(strings.TrimPrefix(reply, agentQuestionReplyOpen), agentQuestionReplyClose)
	var entries []struct {
		QuestionItemID string `json:"questionItemId"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(body)), &entries); err != nil || len(entries) != 1 {
		t.Fatalf("reply envelope %q: %v", reply, err)
	}
	if want := `["request_user_input_async","call_7aa",0]`; entries[0].QuestionItemID != want {
		t.Fatalf("questionItemId = %s, want %s", entries[0].QuestionItemID, want)
	}
}
