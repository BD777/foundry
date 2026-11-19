package channels_test

import (
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func reactRecord() store.MessageChannelDeliveryRecord {
	record := store.MessageChannelDeliveryRecord{}
	record.Rule = "group"
	record.Envelope = store.MessageEnvelope{ID: "new:1", MessageID: "1", Op: "new", Text: "/ai 看下这个",
		Conversation: store.MessageEnvelopeConversation{ID: "oc_group", Kind: "group", Name: "项目群"},
		Sender:       store.MessageEnvelopeSender{ID: "ou_me", Name: "我", IsSelf: true}}
	return record
}

func TestNoticeStatesTheReactionCommandOnlyWhenTheSourceDeclaresOne(t *testing.T) {
	channel := store.MessageChannel{ID: "mch_x", Name: "工作"}
	records := []store.MessageChannelDeliveryRecord{reactRecord()}

	with := channels.NoticeWithFacts(channel, "OpenLark", "", "olk im reply {message.id} --thread", "olk im react {message.id} OneSecond --yes",
		channels.Rollover{}, records, channels.Facts{})
	if !strings.Contains(with, "reply: olk im reply 1 --thread\nreact: olk im react 1 OneSecond --yes\n") {
		t.Errorf("notice lacks the filled react fact after reply:\n%s", with)
	}

	without := channels.NoticeWithFacts(channel, "OpenLark", "", "olk im reply {message.id} --thread", "",
		channels.Rollover{}, records, channels.Facts{})
	if strings.Contains(without, "react:") {
		t.Errorf("notice without a reaction command states a react fact:\n%s", without)
	}
}
