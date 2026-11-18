package personalagent

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's answer to a question the assistant asked is their words: the
// answer is quotable as theirs, the framing Foundry put around it is not.
func TestAnAnswerToAnAssistantQuestionIsThePersonsWords(t *testing.T) {
	answered := store.SessionInput{
		Prompt:      AnswerFrame("Which folder?", "The Q3 folder, please."),
		InputSource: &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: store.NoticeKindQuestionAnswer},
	}
	words, ok := PersonWords(answered)
	if !ok || words != "The Q3 folder, please." {
		t.Fatalf("PersonWords = %q, %v", words, ok)
	}
	if !QuoteGrounded("The Q3 folder", []string{words}) {
		t.Fatal("the answer is not quotable as the person's words")
	}
	if QuoteGrounded("answered your question", []string{words}) {
		t.Fatal("the framing counts as the person's words")
	}

	// Another server notice, and an answer whose framing was lost, are not theirs.
	reminder := store.SessionInput{Prompt: Notice("the Q3 folder is due"), InputSource: &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: "reminder"}}
	if words, ok := PersonWords(reminder); ok {
		t.Fatalf("a reminder counted as the person's words: %q", words)
	}
	unframed := store.SessionInput{Prompt: "The Q3 folder, please.", InputSource: answered.InputSource}
	if words, ok := PersonWords(unframed); ok {
		t.Fatalf("an answer without its framing counted as the person's words: %q", words)
	}
	empty := store.SessionInput{Prompt: AnswerFrame("Which folder?", "  "), InputSource: answered.InputSource}
	if words, ok := PersonWords(empty); ok {
		t.Fatalf("an empty answer counted: %q", words)
	}
}
