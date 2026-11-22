package sessions

import (
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// QuestionReplyOpen opens the envelope an answer to a session's question
// travels in (@bd777/foundry-protocol agentQuestionReplyText).
const QuestionReplyOpen = "<send_user_message_question_reply>"

// QuestionEventWindow is how many of a session's latest events are read for
// the question it waits on.
const QuestionEventWindow = 200

// WaitingQuestion is the latest question among a session's events (oldest
// first) still waiting for an answer: one recorded since input, the session's
// latest, with no answer steered into the turn after it and not settled
// without one (timed out or interrupted while it held the turn).
func WaitingQuestion(events []store.AgentSessionEvent, input store.SessionInput) (store.TranscriptMessage, bool) {
	started, _ := time.Parse(time.RFC3339Nano, input.At)
	settled := map[string]bool{}
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if at, err := time.Parse(time.RFC3339Nano, event.At); err == nil && !started.IsZero() && at.Before(started) {
			break
		}
		if event.Label == store.EventLabelSteeredIntoTurn && strings.Contains(event.Detail, QuestionReplyOpen) {
			break
		}
		if event.Label == store.EventLabelQuestionSettled {
			settled[nativeItemID(strings.TrimSpace(event.Detail))] = true
			continue
		}
		if message := event.Message; message != nil && len(message.Questions) > 0 && !settled[nativeItemID(message.ID)] {
			return *message, true
		}
	}
	return store.TranscriptMessage{}, false
}

// nativeItemID is the runtime's id of a transcript item: a Foundry id
// without the path it may carry.
func nativeItemID(id string) string {
	if at := strings.LastIndex(id, "/"); at >= 0 {
		return id[at+1:]
	}
	return id
}
