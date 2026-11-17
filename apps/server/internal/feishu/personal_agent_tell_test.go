package feishu

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sentCards takes the cards the bot sent to a chat.
func (b *fakeBot) sentCards() []struct{ to, card string } {
	b.mu.Lock()
	defer b.mu.Unlock()
	cards := b.sent
	b.sent = nil
	return cards
}

// TellPerson is the one message a session sends the person outside its own
// conversation (DEV-278): one card in the paired direct chat, nothing when
// the person turned that chat off.
func TestTellPersonPostsOneNoteToThePairedDirectChat(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := store.PersonalAgent{
		ID: "asst_person", UserID: f.person.ID,
		Settings: store.PersonalAgentSettings{FeishuDirectChat: true},
	}
	const note = "The image did not make it into the thread."
	posted, err := f.manager.TellPerson(ctx, agent, note, "https://example.invalid/sess_1")
	if err != nil || !posted {
		t.Fatalf("TellPerson = %v, %v", posted, err)
	}
	sent := f.bot.sentCards()
	if len(sent) != 1 || sent[0].to != "oc_dm" ||
		!strings.Contains(sent[0].card, note) ||
		!strings.Contains(sent[0].card, "https://example.invalid/sess_1") {
		t.Fatalf("tell card = %+v", sent)
	}

	agent.Settings.FeishuDirectChat = false
	posted, err = f.manager.TellPerson(ctx, agent, "nothing to say", "")
	if err != nil || posted {
		t.Fatalf("TellPerson with the chat off = %v, %v", posted, err)
	}
	if sent := f.bot.sentCards(); len(sent) != 0 {
		t.Fatalf("a switched-off chat got a card: %+v", sent)
	}
}
