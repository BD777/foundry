package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
)

// The no-answer reply names each question by the item and index the Worker
// matches, marks it noAnswer and carries the reason; it has no answer.
func TestAgentQuestionNoAnswerTextNamesEachQuestionAndTheReason(t *testing.T) {
	text, err := agentQuestionNoAnswerText("not needed any more", []questionRef{
		{itemID: "turn_1/call_9", question: "Which file?"},
		{itemID: "turn_1/call_10", question: "Which branch?"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(text, agentQuestionReplyOpen) || !strings.HasSuffix(text, agentQuestionReplyClose+"\n") {
		t.Fatalf("not in the reply envelope: %q", text)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(text, agentQuestionReplyOpen), agentQuestionReplyClose+"\n")
	var entries []map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(body)), &entries); err != nil {
		t.Fatalf("entries are not JSON: %v in %q", err, body)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want one per question", entries)
	}
	for index, want := range []struct{ call, question string }{{"call_9", "Which file?"}, {"call_10", "Which branch?"}} {
		entry := entries[index]
		if entry["noAnswer"] != true || entry["reason"] != "not needed any more" || entry["question"] != want.question {
			t.Fatalf("entry %d = %+v", index, entry)
		}
		if _, hasAnswer := entry["answer"]; hasAnswer {
			t.Fatalf("entry %d carries an answer: %+v", index, entry)
		}
		var target []any
		if err := json.Unmarshal([]byte(entry["questionItemId"].(string)), &target); err != nil {
			t.Fatalf("questionItemId of entry %d: %v", index, err)
		}
		if len(target) != 3 || target[0] != "request_user_input_async" || target[1] != want.call || target[2] != float64(0) {
			t.Fatalf("questionItemId of entry %d = %v, want the question's call %s", index, target, want.call)
		}
	}
}
