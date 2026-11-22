package httpapi

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Notices go only as the Foundry bot's cards: the instances a notice setting
// may name are the bot alone, even beside the person's extension instances.
func TestNoticeInstancesAreTheFoundryBotOnly(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	if _, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "xapp_notice_server", Provider: "openlark", OwnerUserID: f.aliceID, Visibility: store.ExternalAppPersonal,
		Label: "OpenLark", CreatedVia: "extension", ExtensionData: "{}",
	}); err != nil {
		t.Fatal(err)
	}
	instances, err := f.server.listPersonalAgentNotifyInstances(ctx, store.PersonalAgent{UserID: f.aliceID})
	if err != nil {
		t.Fatal(err)
	}
	if len(instances) != 1 || instances[0].ConnectorInstanceID != feishu.NoticeSinkID || instances[0].Reason != notifyReasonFeishuNotPaired {
		t.Fatalf("instances = %+v, want the Foundry bot alone, not paired yet", instances)
	}
}

// Saving a notice setting refuses anything but the Foundry bot: a connector's
// plain-text message is not a notice.
func TestNoticeSettingRefusesAConnectorSink(t *testing.T) {
	if _, err := normalizePersonalAgentNotify(store.PersonalAgentNotifySettings{
		Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: "xapp_notice_server", Kinds: []string{"question"}}},
	}); err == nil || err.Error() != notifyOnlyBotMessage {
		t.Fatalf("a connector sink was accepted (%v)", err)
	}
}
